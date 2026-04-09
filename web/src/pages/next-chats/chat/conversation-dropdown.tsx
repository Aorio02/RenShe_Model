import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

import {
  useGetChatSearchParams,
  useRemoveConversation,
} from '@/hooks/use-chat-request';
import { IConversation } from '@/interfaces/database/chat';
import { Trash2, Download } from 'lucide-react';
import { MouseEventHandler, PropsWithChildren, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatUrlParams } from '../hooks/use-chat-url';

export function ConversationDropdown({
  children,
  conversation,
  removeTemporaryConversation,
  exportType = 'table',
}: PropsWithChildren & {
  conversation: IConversation;
  removeTemporaryConversation?: (conversationId: string) => void;
  exportType?: 'conversation' | 'table';
}) {
  const { t } = useTranslation();
  const { setConversationBoth } = useChatUrlParams();
  const { removeConversation } = useRemoveConversation();
  const { isNew } = useGetChatSearchParams();

  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [idCardNumber, setIdCardNumber] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  const handleDelete: MouseEventHandler<HTMLDivElement> =
    useCallback(async () => {
      try {
        if (isNew === 'true' && removeTemporaryConversation) {
          removeTemporaryConversation(conversation.id);
          toast.success(t('chat.deleteSuccess') || '删除成功', {
            description: `"${conversation.name}" ${t('chat.hasBeenDeleted') || '已被删除'}`,
          });
        } else {
          const code = await removeConversation([conversation.id]);
          if (code === 0) {
            setConversationBoth('', '');
            toast.success(t('chat.deleteSuccess') || '删除成功', {
              description: `"${conversation.name}" ${t('chat.hasBeenDeleted') || '已被删除'}`,
            });
          } else {
            toast.error(t('chat.deleteFailed') || '删除失败', {
              description: t('chat.tryAgainLater') || '请稍后重试',
            });
          }
        }
      } catch (error) {
        console.error('Delete error:', error);
        toast.error(t('chat.deleteFailed') || '删除失败', {
          description: t('chat.tryAgainLater') || '请稍后重试',
        });
      }
    }, [
      conversation.id,
      conversation.name,
      isNew,
      removeConversation,
      removeTemporaryConversation,
      setConversationBoth,
      t,
    ]);

  const handleOpenExportDialog = useCallback(() => {
    setIdCardNumber('');
    setIsExportDialogOpen(true);
  }, []);

  const handleCloseExportDialog = useCallback(() => {
    if (!isExporting) {
      setIsExportDialogOpen(false);
    }
  }, [isExporting]);

  const handleConfirmExport = useCallback(async () => {
    if (!idCardNumber.trim()) {
      toast.error(t('chat.pleaseEnterIdCard') || '请输入身份证号');
      return;
    }

    setIsExporting(true);

    const loadingToastId = toast.loading(t('chat.exporting') || '正在校验并导出...', {
      description: t('chat.pleaseWait') || '请稍候',
    });

    try {
      const response = await fetch(`/v1/conversation/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversation_id: conversation.id,
          id_card_number: idCardNumber.trim(),
          export_type: exportType,
        }),
      });

      if (!response.ok) {
        let errorMsg = t('chat.exportFailed') || '导出失败';
        let showDesc = t('chat.checkIdCard') || '请检查身份证号是否正确';

        try {
          const errData = await response.json();
          const backendMsg = errData.message || errData.msg || errData.error;
          if (backendMsg) {
            errorMsg = backendMsg; 
            showDesc = ''; 
          }
        } catch (e) {
          // ignore parse error
        }
        
        toast.error(errorMsg, {
          id: loadingToastId,
          description: showDesc || undefined,
        });
        throw new Error('Export failed');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      const disposition = response.headers.get('Content-Disposition');
      let filename = `${conversation.name}_export.json`;
      if (disposition && disposition.indexOf('attachment') !== -1) {
        const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
        const matches = filenameRegex.exec(disposition);
        if (matches != null && matches[1]) { 
          filename = matches[1].replace(/['"]/g, '');
        }
      }
      
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      handleCloseExportDialog();
      
      toast.success(t('chat.exportSuccess') || '导出成功', {
        id: loadingToastId,
        description: `${filename} ${t('chat.downloadStarted') || '已开始下载'}`,
      });

    } catch (error: any) {
      console.error('Export error:', error);
      
      const friendlyMessage = t('chat.exportFailed') || '导出失败';
      const friendlyDesc = t('chat.checkIdCard') || '请检查身份证号或网络连接';

      toast.error(friendlyMessage, {
        id: loadingToastId,
        description: friendlyDesc,
      });
    } finally {
      setIsExporting(false);
    }
  }, [conversation.id, conversation.name, idCardNumber, t, handleCloseExportDialog]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={handleOpenExportDialog}>
            <Download className="mr-2 h-4 w-4" />
            {t('chat.export') || '导出'}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <ConfirmDeleteDialog onOk={handleDelete}>
            <DropdownMenuItem
              className="text-state-error"
              onSelect={(e) => {
                e.preventDefault();
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t('common.delete')}
            </DropdownMenuItem>
          </ConfirmDeleteDialog>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={isExportDialogOpen} onOpenChange={setIsExportDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('chat.exportConversation') || '导出会话'}</DialogTitle>
            <DialogDescription>
              {t('chat.enterIdCardToExport') || '请输入您的身份证号以验证身份并导出聊天记录。'}
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="idCard" className="text-right text-sm font-medium">
                {t('chat.idCardNumber') || '身份证号'}
              </label>
              <Input
                id="idCard"
                value={idCardNumber}
                onChange={(e) => setIdCardNumber(e.target.value)}
                placeholder={t('common.idCardPlaceholder') || '请输入身份证号'}
                className="col-span-3"
                disabled={isExporting}
                inputMode="text"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isExporting) {
                    handleConfirmExport();
                  }
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseExportDialog} disabled={isExporting}>
              {t('common.cancel') || '取消'}
            </Button>
            <Button onClick={handleConfirmExport} disabled={isExporting}>
              {isExporting ? (t('common.exporting') || '导出中...') : (t('common.confirm') || '确认')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}