import { useEffect, useState } from 'react';
import { DiscordUploadSource, sendFilesToDiscord } from '@/lib/discordWebhook';

export interface DiscordSendStatus {
  tone: 'success' | 'error' | 'progress';
  message: string;
}

export const useDiscordWebhookSender = (webhookUrl: string) => {
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<DiscordSendStatus | null>(null);

  useEffect(() => {
    setStatus(null);
  }, [webhookUrl]);

  const send = async (requestId: string, sources: DiscordUploadSource[]) => {
    if (activeRequestId) return;

    setActiveRequestId(requestId);
    setStatus({ tone: 'progress', message: 'Discord로 파일을 전송하는 중입니다...' });

    try {
      await sendFilesToDiscord(webhookUrl, sources, {
        onBatchProgress: (completed, total) => {
          if (total > 1 && completed < total) {
            setStatus({ tone: 'progress', message: `Discord 전송 중 ${completed}/${total} 묶음 완료` });
          }
        },
      });
      setStatus({ tone: 'success', message: `${sources.length}개 파일을 Discord로 보냈습니다.` });
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Discord 전송 중 오류가 발생했습니다.',
      });
    } finally {
      setActiveRequestId(null);
    }
  };

  return { activeRequestId, status, send };
};
