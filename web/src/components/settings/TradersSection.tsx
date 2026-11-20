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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Traders to Copy</CardTitle>
        <CardDescription>
          Managed only from this dashboard (stored in MongoDB). Paste one address
          or a comma-separated list.
        </CardDescription>
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
      </CardContent>
    </Card>
  );
}
