'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { parseTraderListInput } from '@/lib/traders';

interface TradersSectionProps {
  traders: string[];
  traderLabels: Record<string, string>;
  onChange: (traders: string[]) => void;
}

export function TradersSection({ traders, traderLabels, onChange }: TradersSectionProps) {
  const [newTrader, setNewTrader] = useState('');
  const [error, setError] = useState('');
  const [pruneLoading, setPruneLoading] = useState(false);
  const [pruneMessage, setPruneMessage] = useState<string | null>(null);

  const handleAdd = () => {
    const candidates = parseTraderListInput(newTrader);

    if (candidates.length === 0) {
      setError(
        'Enter a valid 0x address, or paste a comma-separated / JSON list'
      );
      return;
    }

    const existing = new Set(traders.map((t) => t.toLowerCase()));
    const toAdd = candidates.filter((addr) => !existing.has(addr));

    if (toAdd.length === 0) {
      setError(
        candidates.length === 1
          ? 'Trader already in list'
          : 'All pasted addresses are already in the list'
      );
      return;
    }

    onChange([...traders, ...toAdd]);
    setNewTrader('');
    setError('');
  };

  const handleRemove = (address: string) => {
    onChange(traders.filter((t) => t.toLowerCase() !== address.toLowerCase()));
  };

  const getLabel = (address: string): string | null => {
    const label = traderLabels[address.toLowerCase()];
    return label || null;
  };

  const truncateAddress = (address: string): string => {
    return `${address.slice(0, 8)}...${address.slice(-6)}`;
  };

  const handleExport = () => {
    if (traders.length === 0) return;

    const hasLabels = traders.some((a) => Boolean(getLabel(a)));
    const body = hasLabels
      ? [
          'address,label',
          ...traders.map((a) => {
            const label = getLabel(a) || '';
            const safe = label.includes(',') || label.includes('"')
              ? `"${label.replace(/"/g, '""')}"`
              : label;
            return `${a},${safe}`;
          }),
        ].join('\n')
      : traders.join('\n');

    const blob = new Blob([body + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = hasLabels
      ? `agreebot-traders-${stamp}.csv`
      : `agreebot-traders-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRemoveWithoutFills = async () => {
    if (traders.length === 0) return;
    setPruneLoading(true);
    setPruneMessage(null);
    setError('');
    try {
      const res = await fetch('/api/traders/without-fills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traders }),
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to find wallets without fills');
      }
      const without: string[] = Array.isArray(data.withoutFills) ? data.withoutFills : [];
      if (without.length === 0) {
        setPruneMessage('Every wallet already has at least one fill — nothing to remove.');
        return;
      }
      if (
        !window.confirm(
          `Remove ${without.length} wallet${without.length === 1 ? '' : 's'} with no fills?\n\n` +
            `These addresses never appeared on an entered bot trade. Click Save afterwards to persist.`
        )
      ) {
        return;
      }
      const drop = new Set(without.map((a) => a.toLowerCase()));
      const kept = traders.filter((a) => !drop.has(a.toLowerCase()));
      onChange(kept);
      setPruneMessage(
        `Removed ${without.length} wallet${without.length === 1 ? '' : 's'} without fills ` +
          `(${kept.length} remaining). Click Save to apply.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove wallets without fills');
    } finally {
      setPruneLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Traders to Copy</CardTitle>
          <CardDescription>
            Managed only from this dashboard (stored in MongoDB). Paste one address
            or a comma-separated list.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRemoveWithoutFills}
            disabled={traders.length === 0 || pruneLoading}
          >
            {pruneLoading ? 'Checking…' : 'Remove wallets without fills'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={traders.length === 0}
          >
            Export
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {traders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No traders configured</p>
          ) : (
            traders.map((address) => {
              const label = getLabel(address);
              return (
                <div
                  key={address}
                  className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <code className="text-sm font-mono">{truncateAddress(address)}</code>
                    {label && <Badge variant="secondary">{label}</Badge>}
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={`https://polymarket.com/profile/${address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:underline"
                    >
                      View
                    </a>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemove(address)}
                      className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              placeholder="0x… or paste 0xaaa,0xbbb,0xccc"
              value={newTrader}
              onChange={(e) => {
                setNewTrader(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              error={error}
            />
          </div>
          <Button onClick={handleAdd}>Add</Button>
        </div>

        <p className="text-xs text-muted-foreground">
          {traders.length} trader{traders.length !== 1 ? 's' : ''} configured ·
          commas, spaces, newlines, or a JSON array all work
        </p>
        {pruneMessage && (
          <p className="text-xs text-muted-foreground border-l-2 border-primary/40 pl-2">
            {pruneMessage}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
