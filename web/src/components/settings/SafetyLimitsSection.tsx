'use client';

import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { BotSettings } from '@/types/settings';

interface SafetyLimitsSectionProps {
  safetyLimits: BotSettings['safetyLimits'];
  onChange: (update: Partial<BotSettings['safetyLimits']>) => void;
}

export function SafetyLimitsSection({ safetyLimits, onChange }: SafetyLimitsSectionProps) {
  const skipSlippage = Boolean(safetyLimits.skipPriceSlippage);
  const maxSlippage = Number.isFinite(safetyLimits.maxSlippagePercent)
    ? safetyLimits.maxSlippagePercent
    : 15;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Safety Limits</CardTitle>
        <CardDescription>
          Protect your account with order and position limits
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="Max Order Size ($)"
            type="number"
            step="1"
            value={safetyLimits.maxOrderSizeUSD}
            onChange={(e) => onChange({ maxOrderSizeUSD: parseFloat(e.target.value) || 0 })}
          />
          <Input
            label="Min Order Size ($)"
            type="number"
            step="0.1"
            value={safetyLimits.minOrderSizeUSD}
            onChange={(e) => onChange({ minOrderSizeUSD: parseFloat(e.target.value) || 0 })}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="Max Position Size ($) - optional"
            type="number"
            step="1"
            value={safetyLimits.maxPositionSizeUSD ?? ''}
            onChange={(e) => onChange({
              maxPositionSizeUSD: e.target.value ? parseFloat(e.target.value) : null
            })}
            placeholder="No limit"
          />
          <Input
            label="Max Daily Volume ($) - optional"
            type="number"
            step="1"
            value={safetyLimits.maxDailyVolumeUSD ?? ''}
            onChange={(e) => onChange({
              maxDailyVolumeUSD: e.target.value ? parseFloat(e.target.value) : null
            })}
            placeholder="No limit"
          />
        </div>

        <div className="border-t border-border pt-4 space-y-4">
          <Switch
            checked={skipSlippage}
            onCheckedChange={(checked) => onChange({ skipPriceSlippage: checked })}
            label="Skip price slippage check"
            description="Buy at the best ask even if it is outside ±% of the last agreeing trader’s price"
          />
          <Input
            label="Max Slippage (%)"
            type="number"
            step="1"
            min="1"
            value={maxSlippage}
            disabled={skipSlippage}
            onChange={(e) =>
              onChange({
                maxSlippagePercent: Math.max(1, parseFloat(e.target.value) || 15),
              })
            }
          />
        </div>

        <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg space-y-1">
          <p><strong>Max Order Size:</strong> Maximum size for a single order (prevents oversized trades)</p>
          <p><strong>Min Order Size:</strong> Orders below this will be skipped (Polymarket requires $1 min)</p>
          <p><strong>Max Position Size:</strong> Maximum total value in one market</p>
          <p><strong>Max Daily Volume:</strong> Maximum trading volume per day</p>
          <p><strong>Skip price slippage:</strong> Disables the ±% ask vs last-agreeing-fill band (more fills, worse prices possible)</p>
          <p><strong>Max Slippage:</strong> Allowed ask band around the reference buy price when slippage check is on</p>
        </div>
      </CardContent>
    </Card>
  );
}
