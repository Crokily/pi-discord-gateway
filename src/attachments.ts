export interface AttachmentMeta {
  url: string;
  name: string;
  contentType: string;
  size: number;
}

export interface AttachmentLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
}

export type AttachmentRejectionReason = 'file-too-large' | 'total-too-large';

export interface RejectedAttachment {
  attachment: AttachmentMeta;
  reason: AttachmentRejectionReason;
  limitBytes: number;
}

export interface AttachmentSelection {
  accepted: AttachmentMeta[];
  rejected: RejectedAttachment[];
  totalAcceptedBytes: number;
}

export function selectAttachmentsWithinLimits(
  attachments: AttachmentMeta[],
  limits: AttachmentLimits,
): AttachmentSelection {
  const accepted: AttachmentMeta[] = [];
  const rejected: RejectedAttachment[] = [];
  let totalAcceptedBytes = 0;

  for (const attachment of attachments) {
    if (limits.maxFileBytes > 0 && attachment.size > limits.maxFileBytes) {
      rejected.push({
        attachment,
        reason: 'file-too-large',
        limitBytes: limits.maxFileBytes,
      });
      continue;
    }

    if (limits.maxTotalBytes > 0 && totalAcceptedBytes + attachment.size > limits.maxTotalBytes) {
      rejected.push({
        attachment,
        reason: 'total-too-large',
        limitBytes: limits.maxTotalBytes,
      });
      continue;
    }

    accepted.push(attachment);
    totalAcceptedBytes += attachment.size;
  }

  return { accepted, rejected, totalAcceptedBytes };
}

export function buildAttachmentOnlyPrompt(attachmentCount: number): string {
  if (attachmentCount <= 1) {
    return '[Attachment-only message: 1 file attached.]';
  }

  return `[Attachment-only message: ${attachmentCount} files attached.]`;
}
