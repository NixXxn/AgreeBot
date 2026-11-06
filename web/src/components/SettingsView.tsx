'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { TradersSection } from '@/components/settings/TradersSection';
import { CopyStrategySection } from '@/components/settings/CopyStrategySection';
import { SafetyLimitsSection } from '@/components/settings/SafetyLimitsSection';
import { BotSettingsSection } from '@/components/settings/BotSettingsSection';
import { QuickActionsSection } from '@/components/settings/QuickActionsSection';
import {
  BotSettings,
  SettingsResponse,
  SettingsUpdate,
  HealthCheckResult,
  BalanceInfo,
} from '@/types/settings';

export function SettingsView() {
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [traderLabels, setTraderLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [healthCheck, setHealthCheck] = useState<HealthCheckResult | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);

  // Fetch settings
  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/settings', { cache: 'no-store' });
      const data: SettingsResponse = await response.json();

      if (!response.ok) {
        throw new Error((data as unknown as { error: string }).error || 'Failed to load settings');
      }

      setSettings(data.settings);
      setTraderLabels(data.traderLabels);
      setError(null);
      setHasChanges(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch health check
  const fetchHealth = useCallback(async () => {
    try {
      const response = await fetch('/api/health');
      const data: HealthCheckResult = await response.json();
      setHealthCheck(data);
    } catch (err) {
      console.error('Failed to fetch health:', err);
    }
  }, []);

  // Fetch balance
  const fetchBalance = useCallback(async () => {
    try {
      const response = await fetch('/api/balance');
      if (!response.ok) {
        setBalance(null);
        return;
      }
      const data = await response.json();
      if (
        typeof data?.usdc === 'number' &&
        typeof data?.matic === 'number'
      ) {
        setBalance(data as BalanceInfo);
      } else {
        setBalance(null);
      }
    } catch (err) {
      console.error('Failed to fetch balance:', err);
      setBalance(null);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchHealth();
    fetchBalance();
  }, [fetchSettings, fetchHealth, fetchBalance]);

  // Save settings
  const saveSettings = async () => {
    if (!settings) return;

    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);

      const update: SettingsUpdate = {
        traders: settings.traders,
        copyStrategy: settings.copyStrategy,
        safetyLimits: settings.safetyLimits,
        adaptiveStrategy: settings.adaptiveStrategy,
        botSettings: settings.botSettings,
        network: settings.network,
      };

      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
        cache: 'no-store',
      });

      let data: {
        settings?: BotSettings;
        traderLabels?: Record<string, string>;
        error?: string;
        message?: string;
      };
      try {
        data = await response.json();
      } catch {
        throw new Error(
          response.ok
            ? 'Save succeeded but returned invalid JSON'
            : `Failed to save settings (HTTP ${response.status})`
        );
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save settings');
      }

      if (!data.settings?.traders) {
        throw new Error('Save response missing traders — settings may not have persisted');
      }

      // Confirm round-trip: reload from GET (Mongo merge) so UI matches disk
      const verify = await fetch('/api/settings', { cache: 'no-store' });
      const verified: SettingsResponse = await verify.json();
      if (!verify.ok) {
        throw new Error(
          (verified as unknown as { error?: string }).error ||
            'Saved, but failed to re-read settings from server'
        );
      }

      const expected = [...settings.traders].map((a) => a.toLowerCase()).sort();
      const actual = [...verified.settings.traders].map((a) => a.toLowerCase()).sort();
      if (
        expected.length !== actual.length ||
        expected.some((addr, i) => addr !== actual[i])
      ) {
        throw new Error(
          `Save did not persist traders (sent ${expected.length}, got ${actual.length} after reload). Check MongoDB / MONGO_URI.`
        );
      }

      setSettings(verified.settings);
      setTraderLabels(verified.traderLabels || {});
      setHasChanges(false);
      setSuccessMessage(
        data.message ||
          `Saved ${verified.settings.traders.length} trader(s) to MongoDB. Restart the bot container to reload them.`
      );

      // Clear success message after 8 seconds
      setTimeout(() => setSuccessMessage(null), 8000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // Update handlers
  const updateSettings = <K extends keyof BotSettings>(
    key: K,
    value: BotSettings[K] | Partial<BotSettings[K]>
  ) => {
    if (!settings) return;

    setSettings(prev => {
      if (!prev) return prev;

      // Handle partial updates for nested objects
      if (typeof value === 'object' && !Array.isArray(value)) {
        return {
          ...prev,
          [key]: { ...prev[key], ...value },
        };
      }

      return {
        ...prev,
        [key]: value,
      };
    });
    setHasChanges(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-semibold text-red-500 mb-2">Error</h2>
          <p className="text-muted-foreground mb-4">{error}</p>
          <Button onClick={fetchSettings}>Retry</Button>
        </div>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="space-y-6">
      {/* Header with Save Button */}
      <div className="flex items-center justify-between sticky top-0 bg-background py-4 z-10 border-b">
        <div>
          <h2 className="text-xl font-semibold">Bot Settings</h2>
          <p className="text-sm text-muted-foreground">
            Configure copy trading parameters
          </p>
        </div>
        <div className="flex items-center gap-3">
          {hasChanges && (
            <span className="text-sm text-yellow-500">Unsaved changes</span>
          )}
          <Button
            onClick={saveSettings}
            disabled={!hasChanges || saving}
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {successMessage && (
        <Alert variant="success">
          <AlertTitle>Success</AlertTitle>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      {/* Settings Sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-6">
          <TradersSection
            traders={settings.traders}
            traderLabels={traderLabels}
            onChange={(traders) => updateSettings('traders', traders)}
          />

          <CopyStrategySection
            copyStrategy={settings.copyStrategy}
            adaptiveStrategy={settings.adaptiveStrategy}
            onCopyStrategyChange={(update) => updateSettings('copyStrategy', update)}
            onAdaptiveStrategyChange={(update) => updateSettings('adaptiveStrategy', update)}
          />

          <SafetyLimitsSection
            safetyLimits={settings.safetyLimits}
            onChange={(update) => updateSettings('safetyLimits', update)}
          />
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          <BotSettingsSection
            botSettings={settings.botSettings}
            network={settings.network}
            wallet={settings.wallet}
            balance={balance}
            onBotSettingsChange={(update) => updateSettings('botSettings', update)}
            onNetworkChange={(update) => updateSettings('network', update)}
          />

          <QuickActionsSection
            healthCheck={healthCheck}
            onRefreshHealth={fetchHealth}
            paperMode={Boolean(settings.botSettings?.previewMode)}
          />
        </div>
      </div>
    </div>
  );
}
