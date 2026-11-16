'use client';

import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { BotSettings, BalanceInfo, AutoClaimStatus } from '@/types/settings';

interface BotSettingsSectionProps {
  botSettings: BotSettings['botSettings'];
  network: BotSettings['network'];
  wallet: BotSettings['wallet'];
  balance: BalanceInfo | null;
  autoClaim: AutoClaimStatus | null;
  onBotSettingsChange: (update: Partial<BotSettings['botSettings']>) => void;
  onNetworkChange: (update: Partial<BotSettings['network']>) => void;
}

function formatClaimTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function truncateHash(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export function BotSettingsSection({
  botSettings,
  network,
  wallet,
  balance,
  autoClaim,
  onBotSettingsChange,
  onNetworkChange,
}: BotSettingsSectionProps) {
  // Harden against partial API payloads (Coolify / older deploys)
  const safe = {
    ...botSettings,
    tradeAggregationEnabled: Boolean(botSettings?.tradeAggregationEnabled),
    tradeAggregationWindowSeconds: botSettings?.tradeAggregationWindowSeconds ?? 300,
    previewMode: Boolean(botSettings?.previewMode),
    consensusEnabled: Boolean(botSettings?.consensusEnabled),
    consensusMinAgreement: botSettings?.consensusMinAgreement ?? 2,
    consensusWindowSeconds: botSettings?.consensusWindowSeconds ?? 300,
    consensusApplyTo: botSettings?.consensusApplyTo ?? 'BUY',
    consensusSizeMode: botSettings?.consensusSizeMode ?? 'AVERAGE',
    autoClaimEnabled: botSettings?.autoClaimEnabled !== false,
    fetchInterval: botSettings?.fetchInterval ?? 1,
    tooOldTimestamp: botSettings?.tooOldTimestamp ?? 24,
    retryLimit: botSettings?.retryLimit ?? 3,
  };

  const truncateAddress = (address: string): string => {
    if (!address) return 'Not configured';
    return `${address.slice(0, 10)}...${address.slice(-8)}`;
  };

  return (
    <div className="space-y-6">
      {/* Bot Mode */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            Bot Mode
            {safe.previewMode ? (
              <Badge variant="warning">Paper / Preview</Badge>
            ) : (
              <Badge variant="success">Live Trading</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Control whether the bot executes real trades
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Switch
            checked={safe.previewMode}
            onCheckedChange={(checked) => onBotSettingsChange({ previewMode: checked })}
            label="Paper / Preview Mode"
            description="Monitor trades but don't execute them (safe testing)"
          />
        </CardContent>
      </Card>

      {/* Wallet Info */}
      <Card>
        <CardHeader>
          <CardTitle>Wallet Info</CardTitle>
          <CardDescription>Your trading wallet (read-only)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-3 bg-muted/50 rounded-lg">
              <p className="text-xs text-muted-foreground mb-1">Proxy Wallet</p>
              <code className="text-sm font-mono">{truncateAddress(wallet.proxyWallet)}</code>
            </div>
            <div className="p-3 bg-muted/50 rounded-lg">
              <p className="text-xs text-muted-foreground mb-1">USDC Contract</p>
              <code className="text-sm font-mono">{truncateAddress(wallet.usdcContract)}</code>
            </div>
          </div>

          {balance && typeof balance.usdc === 'number' && typeof balance.matic === 'number' && (
            <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-muted/50 rounded-lg">
              <p className="text-xs text-muted-foreground mb-1">
                Trading balance (CLOB)
              </p>
              <p className={`text-xl font-bold font-mono ${balance.usdc < 10 ? 'text-yellow-500' : 'text-green-500'}`}>
                ${balance.usdc.toFixed(2)}
              </p>
            </div>
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-xs text-muted-foreground mb-1">MATIC Balance (gas)</p>
                <p className={`text-xl font-bold font-mono ${balance.matic < 0.1 ? 'text-yellow-500' : ''}`}>
                  {balance.matic.toFixed(4)}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Monitoring Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Monitoring Settings</CardTitle>
          <CardDescription>Configure how the bot monitors traders</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              label="Fetch Interval (seconds)"
              type="number"
              min={1}
              value={safe.fetchInterval}
              onChange={(e) => onBotSettingsChange({ fetchInterval: parseInt(e.target.value) || 1 })}
            />
            <Input
              label="Ignore Trades Older Than (hours)"
              type="number"
              min={1}
              value={safe.tooOldTimestamp}
              onChange={(e) => onBotSettingsChange({ tooOldTimestamp: parseInt(e.target.value) || 24 })}
            />
            <Input
              label="Retry Limit"
              type="number"
              min={1}
              max={10}
              value={safe.retryLimit}
              onChange={(e) => onBotSettingsChange({ retryLimit: parseInt(e.target.value) || 3 })}
            />
          </div>

          <div className="border-t pt-4 space-y-4">
            <Switch
              checked={safe.tradeAggregationEnabled}
              onCheckedChange={(checked) => onBotSettingsChange({ tradeAggregationEnabled: checked })}
              label="Trade Aggregation"
              description="Combine multiple small trades into one larger trade"
            />

            {safe.tradeAggregationEnabled && (
              <Input
                label="Aggregation Window (seconds)"
                type="number"
                min={60}
                value={safe.tradeAggregationWindowSeconds}
                onChange={(e) => onBotSettingsChange({
                  tradeAggregationWindowSeconds: parseInt(e.target.value) || 300
                })}
              />
            )}
          </div>

          <div className="border-t pt-4 space-y-4">
            <Switch
              checked={safe.consensusEnabled}
              onCheckedChange={(checked) => onBotSettingsChange({ consensusEnabled: checked })}
              label="Consensus Mode"
              description="Only enter a trade when enough tracked traders agree on the same outcome"
            />

            {safe.consensusEnabled && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Min Traders Agreeing"
                  type="number"
                  min={1}
                  value={safe.consensusMinAgreement}
                  onChange={(e) => onBotSettingsChange({
                    consensusMinAgreement: parseInt(e.target.value) || 2
                  })}
                />
                <Input
                  label="Consensus Window (seconds)"
                  type="number"
                  min={10}
                  value={safe.consensusWindowSeconds}
                  onChange={(e) => onBotSettingsChange({
                    consensusWindowSeconds: parseInt(e.target.value) || 300
                  })}
                />
                <Select
                  label="Apply Consensus To"
                  value={safe.consensusApplyTo}
                  onValueChange={(value) => onBotSettingsChange({
                    consensusApplyTo: value as BotSettings['botSettings']['consensusApplyTo']
                  })}
                  options={[
                    { value: 'BUY', label: 'Buys only (entries)' },
                    { value: 'SELL', label: 'Sells only (exits)' },
                    { value: 'BOTH', label: 'Buys and sells' },
                  ]}
                />
                <Select
                  label="Order Size From Agreement"
                  value={safe.consensusSizeMode}
                  onValueChange={(value) => onBotSettingsChange({
                    consensusSizeMode: value as BotSettings['botSettings']['consensusSizeMode']
                  })}
                  options={[
                    { value: 'AVERAGE', label: 'Average of agreeing trades' },
                    { value: 'LARGEST', label: 'Largest agreeing trade' },
                    { value: 'MEDIAN', label: 'Median agreeing trade' },
                    { value: 'FIRST', label: 'First trader in window' },
                  ]}
                />
              </div>
            )}
          </div>

          <div className="border-t pt-4 space-y-4">
            <Switch
              checked={safe.autoClaimEnabled}
              onCheckedChange={(checked) => onBotSettingsChange({ autoClaimEnabled: checked })}
              label="Auto Claim"
              description="Once per day (live): 100→200 pay $50 · 150→300 pay $100 · 200→400 pay $150 · … Each stage fires only once; baseline never goes back."
            />

            {autoClaim && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Baseline / next stage</p>
                    <p className="font-mono font-medium">
                      ${autoClaim.baseline.toFixed(0)}
                      {autoClaim.baseline >= 100
                        ? ` → $${(autoClaim.baseline * 2).toFixed(0)} (pay $${(
                            autoClaim.baseline - 50
                          ).toFixed(0)})`
                        : ''}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Last check</p>
                    <p className="font-medium">
                      {autoClaim.lastCheckAt
                        ? formatClaimTime(autoClaim.lastCheckAt)
                        : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Last payout</p>
                    <p className="font-mono font-medium">
                      {autoClaim.lastPayoutUsd != null
                        ? `$${autoClaim.lastPayoutUsd.toFixed(2)}`
                        : '—'}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground mb-2">
                    Payout history (persisted)
                  </p>
                  {autoClaim.history.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No auto-claims yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground border-b">
                            <th className="py-1.5 pr-3 font-medium">When</th>
                            <th className="py-1.5 pr-3 font-medium">Stage</th>
                            <th className="py-1.5 pr-3 font-medium">Amount</th>
                            <th className="py-1.5 font-medium">Tx</th>
                          </tr>
                        </thead>
                        <tbody>
                          {autoClaim.history.map((row, i) => {
                            const tx = row.txHash || row.txId;
                            const isHash = Boolean(row.txHash?.startsWith('0x'));
                            const stage =
                              row.stage ||
                              (row.baselineBefore > 0
                                ? `${row.baselineBefore}→${row.baselineBefore * 2}`
                                : '—');
                            return (
                              <tr key={`${row.at}-${i}`} className="border-b border-border/50 last:border-0">
                                <td className="py-2 pr-3 whitespace-nowrap align-top">
                                  {formatClaimTime(row.at)}
                                </td>
                                <td className="py-2 pr-3 font-mono align-top whitespace-nowrap">
                                  {stage}
                                </td>
                                <td className="py-2 pr-3 font-mono align-top">
                                  ${row.amountUsd.toFixed(2)}
                                </td>
                                <td className="py-2 align-top">
                                  {tx ? (
                                    isHash ? (
                                      <a
                                        href={`https://polygonscan.com/tx/${row.txHash}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="font-mono text-xs text-primary underline-offset-2 hover:underline"
                                        title={row.txHash}
                                      >
                                        {truncateHash(row.txHash!)}
                                      </a>
                                    ) : (
                                      <code className="text-xs font-mono" title={tx}>
                                        {truncateHash(tx)}
                                      </code>
                                    )
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Network Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Network Settings</CardTitle>
          <CardDescription>Configure API timeouts and retries</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Request Timeout (ms)"
              type="number"
              min={1000}
              step={1000}
              value={network?.requestTimeoutMs ?? 10000}
              onChange={(e) => onNetworkChange({ requestTimeoutMs: parseInt(e.target.value) || 10000 })}
            />
            <Input
              label="Network Retry Limit"
              type="number"
              min={1}
              max={10}
              value={network?.networkRetryLimit ?? 3}
              onChange={(e) => onNetworkChange({ networkRetryLimit: parseInt(e.target.value) || 3 })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
