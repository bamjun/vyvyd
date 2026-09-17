import React from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { DiscordSendStatus as DiscordSendStatusValue } from '@/hooks/useDiscordWebhookSender';

interface DiscordSendStatusProps {
  status: DiscordSendStatusValue | null;
}

export const DiscordSendStatus: React.FC<DiscordSendStatusProps> = ({ status }) => {
  if (!status) return null;

  const colorClass = status.tone === 'success'
    ? 'border-green-500/20 bg-green-500/10 text-green-300'
    : status.tone === 'error'
      ? 'border-red-500/20 bg-red-500/10 text-red-300'
      : 'border-indigo-500/20 bg-indigo-500/10 text-indigo-300';

  return (
    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${colorClass}`} role="status">
      {status.tone === 'success' ? (
        <CheckCircle2 className="h-4 w-4 shrink-0" />
      ) : status.tone === 'error' ? (
        <AlertCircle className="h-4 w-4 shrink-0" />
      ) : (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      )}
      <span>{status.message}</span>
    </div>
  );
};
