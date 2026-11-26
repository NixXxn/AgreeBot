'use client';

import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { TieredMultipliersEditor } from './TieredMultipliersEditor';
import { BotSettings, CopyStrategy } from '@/types/settings';

interface CopyStrategySectionProps {
  copyStrategy: BotSettings['copyStrategy'];
  adaptiveStrategy: BotSettings['adaptiveStrategy'];
  onCopyStrategyChange: (update: Partial<BotSettings['copyStrategy']>) => void;
  onAdaptiveStrategyChange: (update: Partial<BotSettings['adaptiveStrategy']>) => void;
}

const strategyOptions = [
  { value: 'KELLY', label: 'Half Kelly (bankroll)' },
  { value: 'MARTINGALE', label: 'Martingale (recovery)' },
  { value: 'PERCENTAGE', label: 'Percentage of trader' },
  { value: 'FIXED', label: 'Fixed Amount' },
  { value: 'ADAPTIVE', label: 'Adaptive' },
];

const strategyDescriptions: Record<CopyStrategy, string> = {
  KELLY: 'Size from YOUR budget using fractional Kelly — ignores how big the trader bet',
  MARTINGALE:
    'Start at min shares; after a loss size the next bet so a win recovers lost USD at the new entry price — ignores trader size',
  PERCENTAGE: "Copy a fixed percentage of trader's order size",
  FIXED: 'Copy a fixed dollar amount per trade',
  ADAPTIVE: 'Dynamically adjust percentage based on trade size',
};

export function CopyStrategySection({
  copyStrategy,
  adaptiveStrategy,
  onCopyStrategyChange,
  onAdaptiveStrategyChange,
}: CopyStrategySectionProps) {
  const isAdaptive = copyStrategy.strategy === 'ADAPTIVE';
  const isKelly = copyStrategy.strategy === 'KELLY';
  const isMartingale = copyStrategy.strategy === 'MARTINGALE';
  const ignoresTraderSize = isKelly || isMartingale;
  const kellyFraction = copyStrategy.kellyFraction ?? 0.5;
  const kellyEdge = copyStrategy.kellyEdge ?? 0.05;
  const kellyMaxFraction = copyStrategy.kellyMaxFraction ?? 0.25;
  const martingaleBaseShares = copyStrategy.martingaleBaseShares ?? 5;
  const martingaleMaxSteps = copyStrategy.martingaleMaxSteps ?? 8;

  // Example: $10k bankroll, market 0.40, +5pp edge, half Kelly
  const examplePrice = 0.4;
  const exampleP = Math.min(0.99, examplePrice + kellyEdge);
  const exampleFStar = exampleP > examplePrice ? (exampleP - examplePrice) / (1 - examplePrice) : 0;
  const exampleF = Math.min(kellyFraction * exampleFStar, kellyMaxFraction);
  const exampleStake = 10000 * exampleF;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Copy Strategy</CardTitle>
        <CardDescription>
          Configure how trades are sized — Kelly uses your bankroll, not the trader&apos;s size
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Strategy Selection */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label="Strategy Type"
            value={copyStrategy.strategy}
            onValueChange={(value) => onCopyStrategyChange({ strategy: value as CopyStrategy })}
            options={strategyOptions}
          />
          <div className="flex items-end">
            <p className="text-sm text-muted-foreground pb-2">
              {strategyDescriptions[copyStrategy.strategy]}
            </p>
          </div>
        </div>

        {/* Kelly settings */}
        {isKelly && (
          <div className="p-4 border rounded-lg bg-muted/30 space-y-4">
            <h4 className="font-medium text-sm">Kelly / Half-Kelly Settings</h4>
            <p className="text-xs text-muted-foreground">
              Stake = bankroll × min(fraction × f*, max). f* uses assumed edge over the market price.
              Bankroll is PAPER_BALANCE_USD in paper mode, or your USDC balance live.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                label="Kelly Fraction (0.5 = half)"
                type="number"
                step="0.05"
                min={0.05}
                max={1}
                value={kellyFraction}
                onChange={(e) =>
                  onCopyStrategyChange({ kellyFraction: parseFloat(e.target.value) || 0.5 })
                }
              />
              <Input
                label="Assumed Edge (e.g. 0.05 = +5pp)"
                type="number"
                step="0.01"
                min={0.01}
                max={0.49}
                value={kellyEdge}
                onChange={(e) =>
                  onCopyStrategyChange({ kellyEdge: parseFloat(e.target.value) || 0.05 })
                }
              />
              <Input
                label="Max Bankroll Fraction"
                type="number"
                step="0.05"
                min={0.05}
                max={1}
                value={kellyMaxFraction}
                onChange={(e) =>
                  onCopyStrategyChange({ kellyMaxFraction: parseFloat(e.target.value) || 0.25 })
                }
              />
            </div>
          </div>
        )}

        {/* Martingale settings */}
        {isMartingale && (
          <div className="p-4 border rounded-lg bg-muted/30 space-y-4">
            <h4 className="font-medium text-sm">Martingale Settings</h4>
            <p className="text-xs text-muted-foreground">
              Each circle starts at base shares (Polymarket minimum is usually 5). After a resolved
              loss, the next stake is sized so a win at the new entry price recovers all lost USD
              and still nets one base profit. After a win, the circle resets. Leader size ignored;
              still capped by Max Order Size.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Base shares (start of circle)"
                type="number"
                step="1"
                min={1}
                value={martingaleBaseShares}
                onChange={(e) =>
                  onCopyStrategyChange({
                    martingaleBaseShares: Math.max(1, parseFloat(e.target.value) || 5),
                  })
                }
              />
              <Input
                label="Max recovery steps"
                type="number"
                step="1"
                min={0}
                max={20}
                value={martingaleMaxSteps}
                onChange={(e) =>
                  onCopyStrategyChange({
                    martingaleMaxSteps: Math.max(0, parseInt(e.target.value, 10) || 8),
                  })
                }
              />
            </div>
          </div>
        )}

        {/* Copy Size — not used for Kelly / Martingale */}
        {!ignoresTraderSize && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={copyStrategy.strategy === 'FIXED' ? 'Fixed Amount ($)' : 'Copy Percentage (%)'}
              type="number"
              step="0.1"
              value={copyStrategy.copySize}
              onChange={(e) => onCopyStrategyChange({ copySize: parseFloat(e.target.value) || 0 })}
            />
            <Input
              label="Trade Multiplier"
              type="number"
              step="0.1"
              value={copyStrategy.tradeMultiplier}
              onChange={(e) =>
                onCopyStrategyChange({ tradeMultiplier: parseFloat(e.target.value) || 1 })
              }
            />
          </div>
        )}

        {/* Adaptive Strategy Options */}
        {isAdaptive && (
          <div className="p-4 border rounded-lg bg-muted/30 space-y-4">
            <h4 className="font-medium text-sm">Adaptive Strategy Settings</h4>
            <p className="text-xs text-muted-foreground">
              Small orders use higher %, large orders use lower %
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                label="Min Percent (%)"
                type="number"
                step="0.1"
                value={adaptiveStrategy.minPercent}
                onChange={(e) =>
                  onAdaptiveStrategyChange({ minPercent: parseFloat(e.target.value) || 0 })
                }
              />
              <Input
                label="Max Percent (%)"
                type="number"
                step="0.1"
                value={adaptiveStrategy.maxPercent}
                onChange={(e) =>
                  onAdaptiveStrategyChange({ maxPercent: parseFloat(e.target.value) || 0 })
                }
              />
              <Input
                label="Threshold ($)"
                type="number"
                step="1"
                value={adaptiveStrategy.thresholdUSD}
                onChange={(e) =>
                  onAdaptiveStrategyChange({ thresholdUSD: parseFloat(e.target.value) || 0 })
                }
              />
            </div>
          </div>
        )}

        {/* Tiered Multipliers — not meaningful for Kelly / Martingale */}
        {!ignoresTraderSize && (
          <div className="p-4 border rounded-lg space-y-4">
            <h4 className="font-medium text-sm">Tiered Multipliers (Optional)</h4>
            <TieredMultipliersEditor
              value={copyStrategy.tieredMultipliers}
              onChange={(value) => onCopyStrategyChange({ tieredMultipliers: value })}
            />
          </div>
        )}

        {/* Preview */}
        <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg">
          <p className="font-medium mb-2">Example calculation:</p>
          {isKelly && (
            <p>
              $10k bankroll, market @ {examplePrice.toFixed(2)}, edge +{(kellyEdge * 100).toFixed(0)}
              pp, {kellyFraction}× Kelly → stake ~${exampleStake.toFixed(2)}
              {` (capped at ${(kellyMaxFraction * 100).toFixed(0)}% of bankroll)`}
            </p>
          )}
          {isMartingale && (() => {
            const lossStake = martingaleBaseShares * 0.6;
            const nextPrice = 0.4;
            const recoverShares = lossStake / (1 - nextPrice) + martingaleBaseShares;
            const recoverStake = recoverShares * nextPrice;
            return (
              <p>
                Fresh @ $0.60 → {martingaleBaseShares} shares ≈ ${lossStake.toFixed(2)}. Lose that,
                next @ ${nextPrice.toFixed(2)} → {recoverShares.toFixed(1)} shares ≈ $
                {recoverStake.toFixed(2)} (recovers ${lossStake.toFixed(2)} + nets{' '}
                {(martingaleBaseShares * (1 - nextPrice)).toFixed(2)}). Win → reset.
              </p>
            );
          })()}
          {copyStrategy.strategy === 'PERCENTAGE' && (
            <p>
              Trader buys $100 → You buy $
              {((100 * copyStrategy.copySize) / 100 * copyStrategy.tradeMultiplier).toFixed(2)} (
              {copyStrategy.copySize}% × {copyStrategy.tradeMultiplier}x)
            </p>
          )}
          {copyStrategy.strategy === 'FIXED' && (
            <p>
              Trader buys any amount → You buy $
              {(copyStrategy.copySize * copyStrategy.tradeMultiplier).toFixed(2)} ($
              {copyStrategy.copySize} × {copyStrategy.tradeMultiplier}x)
            </p>
          )}
          {copyStrategy.strategy === 'ADAPTIVE' && (
            <>
              <p>
                Small trade ($50) → {adaptiveStrategy.maxPercent}% = $
                {((50 * adaptiveStrategy.maxPercent) / 100).toFixed(2)}
              </p>
              <p>
                Large trade ($1000) → {adaptiveStrategy.minPercent}% = $
                {((1000 * adaptiveStrategy.minPercent) / 100).toFixed(2)}
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
