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
// 引入 toast
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
}: PropsWithChildren & {
  conversation: IConversation;
  removeTemporaryConversation?: (conversationId: string) => void;
}) {
  const { t } = useTranslation();
  const { setConversationBoth } = useChatUrlParams();
  const { removeConversation } = useRemoveConversation();
  const { isNew } = useGetChatSearchParams();

  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [socialSecurityNumber, setSocialSecurityNumber] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  // --- 删除逻辑 (保持人性化提示) ---
  const handleDelete: MouseEventHandler<HTMLDivElement> =
    useCallback(async () => {
      try {
        if (isNew === 'true' && removeTemporaryConversation) {
          // 本地临时会话删除
          removeTemporaryConversation(conversation.id);
          toast.success(t('chat.deleteSuccess') || '删除成功', {
            description: `"${conversation.name}" ${t('chat.hasBeenDeleted') || '已被删除'}`,
          });
        } else {
          // 后端会话删除
          const code = await removeConversation([conversation.id]);
          if (code === 0) {
            setConversationBoth('', '');
            toast.success(t('chat.deleteSuccess') || '删除成功', {
              description: `"${conversation.name}" ${t('chat.hasBeenDeleted') || '已被删除'}`,
            });
          } else {
            // 如果后端返回错误码
            toast.error(t('chat.deleteFailed') || '删除失败', {
              description: t('chat.tryAgainLater') || '请稍后重试',
            });
          }
        }
      } catch (error) {
        // 只打印错误到控制台，不弹窗具体错误信息
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
    setSocialSecurityNumber('');
    setIsExportDialogOpen(true);
  }, []);

  const handleCloseExportDialog = useCallback(() => {
    if (!isExporting) {
      setIsExportDialogOpen(false);
    }
  }, [isExporting]);

  const handleConfirmExport = useCallback(async () => {
    if (!socialSecurityNumber.trim()) {
      toast.error(t('chat.pleaseEnterSocialSecurity') || '请输入社保卡号');
      return;
    }

    setIsExporting(true);

    const loadingToastId = toast.loading(t('chat.exporting') || '正在校验并导出...', {
      description: t('chat.pleaseWait') || '请稍候',
    });

    try {
      const response = await fetch(`/api/v1/conversation/${conversation.id}/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dialog_id: conversation.id,
          social_security_number: socialSecurityNumber.trim(),
        }),
      });

      if (!response.ok) {
        let errorMsg = t('chat.exportFailed') || '导出失败';
        let showDesc = t('chat.checkSocialSecurity') || '请检查社保卡号是否正确';

        // 尝试解析后端返回的具体业务错误信息
        try {
          const errData = await response.json();
          const backendMsg = errData.message || errData.msg || errData.error;
          if (backendMsg) {
            errorMsg = backendMsg; 
            // 如果后端有具体消息，描述可以留空或给通用提示
            showDesc = ''; 
          }
        } catch (e) {
          // 解析失败可能是纯文本错误或 HTML 错误页，保持默认 errorMsg
        }
        
        toast.error(errorMsg, {
          id: loadingToastId,
          description: showDesc || undefined, // 如果没有描述则不显示描述行
        });
        throw new Error('Export failed'); // 抛出简单错误以进入 catch
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
      // --- 关键修改：隐藏技术细节 ---
      console.error('Export error:', error); // 仅在控制台打印详细错误（含 URL、堆栈等）
      
      // 用户端只显示友好的通用提示，不暴露 error.message (可能包含 Failed to fetch http://...)
      const friendlyMessage = t('chat.exportFailed') || '导出失败';
      const friendlyDesc = t('chat.checkSocialSecurity') || '请检查社保卡号或网络连接';

      toast.error(friendlyMessage, {
        id: loadingToastId,
        description: friendlyDesc,
      });
    } finally {
      setIsExporting(false);
    }
  }, [conversation.id, conversation.name, socialSecurityNumber, t, handleCloseExportDialog]);

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
              {t('chat.enterSocialSecurityToExport') || '请输入您的社保卡号以验证身份并导出聊天记录。'}
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="ssn" className="text-right text-sm font-medium">
                {t('chat.socialSecurityNumber') || '社保卡号'}
              </label>
              <Input
                id="ssn"
                value={socialSecurityNumber}
                onChange={(e) => setSocialSecurityNumber(e.target.value)}
                placeholder={t('common.socialSecurityNumberPlaceholder') || '请输入社保卡号'}
                className="col-span-3"
                disabled={isExporting}
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