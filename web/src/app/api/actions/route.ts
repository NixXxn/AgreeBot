import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ActionRequest, ActionResponse, ActionType } from '@/types/settings';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';

const PROJECT_ROOT = path.join(process.cwd(), '..');

/** Compiled JS under dist/ — production image has no ts-node */
const actionScripts: Record<ActionType, { dist: string; needsWallet: boolean }> = {
  'health-check': { dist: 'dist/scripts/healthCheck.js', needsWallet: false },
  'check-stats': { dist: 'dist/scripts/checkMyStats.js', needsWallet: true },
  'manual-sell': { dist: 'dist/scripts/manualSell.js', needsWallet: true },
  'close-resolved': { dist: 'dist/scripts/closeResolvedPositions.js', needsWallet: true },
  'redeem-resolved': { dist: 'dist/scripts/redeemResolvedPositions.js', needsWallet: true },
  'close-stale': { dist: 'dist/scripts/closeStalePositions.js', needsWallet: true },
};

function readEnvFileValue(key: string): string {
  try {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (!fs.existsSync(envPath)) return '';
    const match = fs.readFileSync(envPath, 'utf-8').match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    if (!match) return '';
    let v = match[1].trim();
    if (
      (v.startsWith("'") && v.endsWith("'")) ||
      (v.startsWith('"') && v.endsWith('"'))
    ) {
      v = v.slice(1, -1);
    }
    return v.trim();
  } catch {
    return '';
  }
}

function getEnv(key: string, overrides: Record<string, string>): string {
  return (
    overrides[key] ||
    process.env[key] ||
    readEnvFileValue(key) ||
    ''
  ).trim();
}

function isPaperMode(overrides: Record<string, string>): boolean {
  return (
    getEnv('PAPER_MODE', overrides) === 'true' ||
    getEnv('PREVIEW_MODE', overrides) === 'true'
  );
}

function hasLiveWallet(overrides: Record<string, string>): boolean {
  const wallet = getEnv('PROXY_WALLET', overrides).replace(/^['"]|['"]$/g, '');
  const key = getEnv('PRIVATE_KEY', overrides).replace(/^['"]|['"]$/g, '');
  if (!wallet || wallet === "''" || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) return false;
  if (!key || key.includes('your_private_key') || key.length < 32) return false;
  return true;
}

async function runNodeScript(
  relPath: string,
  args: string[],
  envExtra: Record<string, string>
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const scriptPath = path.join(PROJECT_ROOT, relPath);
    if (!fs.existsSync(scriptPath)) {
      resolve({
        success: false,
        output:
          `Script not found: ${relPath}\n` +
          `Rebuild the Docker image so dist/scripts is included.`,
      });
      return;
    }

    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];

    const proc = spawn(process.execPath, [scriptPath, ...args], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        ...envExtra,
        FORCE_COLOR: '0',
        NODE_ENV: process.env.NODE_ENV || 'production',
      },
    });

    proc.stdout.on('data', (data) => chunks.push(data));
    proc.stderr.on('data', (data) => errorChunks.push(data));

    const timeout = setTimeout(() => {
      proc.kill();
      resolve({
        success: false,
        output: 'Script timed out after 120 seconds',
      });
    }, 120000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(chunks).toString('utf-8');
      const stderr = Buffer.concat(errorChunks).toString('utf-8');
      const cleanOutput = (stdout + (stderr ? `\n${stderr}` : ''))
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .trim();

      resolve({
        success: code === 0,
        output:
          cleanOutput ||
          (code === 0 ? 'Script completed successfully' : `Script exited with code ${code}`),
      });
    });

    proc.on('error', (error) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        output: `Failed to start script: ${error.message}`,
      });
    });
  });
}

export async function POST(request: Request) {
  try {
    const body: ActionRequest = await request.json();
    const { action, params } = body;

    if (!action || !actionScripts[action]) {
      return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
    }

    const meta = actionScripts[action];
    const overrides = await getRuntimeOverrides();

    if (meta.needsWallet) {
      if (isPaperMode(overrides)) {
        const response: ActionResponse = {
          success: false,
          action,
          output: '',
          error:
            'Paper / preview mode is on — close, redeem and sell need a live wallet. ' +
            'Turn off Paper mode and set PROXY_WALLET + PRIVATE_KEY in Coolify, then restart.',
        };
        return NextResponse.json(response);
      }
      if (!hasLiveWallet(overrides)) {
        const response: ActionResponse = {
          success: false,
          action,
          output: '',
          error:
            'PROXY_WALLET / PRIVATE_KEY not configured (or still placeholders). ' +
            'Set real credentials in Coolify before running live wallet actions.',
        };
        return NextResponse.json(response);
      }
    }

    const args: string[] = [];
    if (action === 'manual-sell' && params?.keyword) {
      args.push(params.keyword);
    }

    // Pass Mongo overrides so scripts see the same settings as the dashboard
    const envExtra: Record<string, string> = { ...overrides };
    if (envExtra.PREVIEW_MODE === 'true' && envExtra.PAPER_MODE === undefined) {
      envExtra.PAPER_MODE = 'true';
    }

    console.log(`Running action: ${action} → node ${meta.dist}`);
    const result = await runNodeScript(meta.dist, args, envExtra);

    const response: ActionResponse = {
      success: result.success,
      action,
      output: result.output,
      error: result.success ? undefined : result.output,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error executing action:', error);
    return NextResponse.json(
      {
        success: false,
        action: 'unknown',
        output: '',
        error: `Failed to execute action: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      { status: 500 }
    );
  }
}
