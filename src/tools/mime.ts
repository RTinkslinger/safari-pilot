/**
 * Phase 5A · 5A.1 — pure mimeFromExtension helper.
 *
 * Coverage policy: ~70 web-common types. Long-tail uncommon types fall back
 * to application/octet-stream with `fallback: true`. Callers (file-upload
 * handler) surface the fallback signal in the response so agents know to
 * pass an explicit mimeOverrides entry if the site validates server-side.
 */
import { extname, basename } from 'node:path';

const TABLE: Record<string, string> = {
  // Documents
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'odt': 'application/vnd.oasis.opendocument.text',
  'ods': 'application/vnd.oasis.opendocument.spreadsheet',
  'rtf': 'application/rtf',
  // Text
  'txt': 'text/plain',
  'md': 'text/markdown',
  'html': 'text/html',
  'htm': 'text/html',
  'css': 'text/css',
  'csv': 'text/csv',
  'tsv': 'text/tab-separated-values',
  'xml': 'application/xml',
  'json': 'application/json',
  'yaml': 'application/yaml',
  'yml': 'application/yaml',
  'js': 'application/javascript',
  'mjs': 'application/javascript',
  'ts': 'application/typescript',
  // Images
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'bmp': 'image/bmp',
  'ico': 'image/vnd.microsoft.icon',
  'tiff': 'image/tiff',
  'tif': 'image/tiff',
  // Audio
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'ogg': 'audio/ogg',
  'm4a': 'audio/mp4',
  'flac': 'audio/flac',
  'aac': 'audio/aac',
  // Video
  'mp4': 'video/mp4',
  'mov': 'video/quicktime',
  'webm': 'video/webm',
  'avi': 'video/x-msvideo',
  'mkv': 'video/x-matroska',
  // Archives
  'zip': 'application/zip',
  'gz': 'application/gzip',
  'tar': 'application/x-tar',
  'bz2': 'application/x-bzip2',
  '7z': 'application/x-7z-compressed',
  'rar': 'application/vnd.rar',
  // Fonts
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'ttf': 'font/ttf',
  'otf': 'font/otf',
  // Code / configs
  'sh': 'application/x-sh',
  'py': 'text/x-python',
  'rb': 'text/x-ruby',
  'go': 'text/x-go',
  'rs': 'text/rust',
  'java': 'text/x-java',
  'c': 'text/x-c',
  'cpp': 'text/x-c++',
  'h': 'text/x-c',
  'swift': 'text/x-swift',
  'sql': 'application/sql',
  'toml': 'application/toml',
  'ini': 'text/plain',
};

export interface MimeResult {
  mimeType: string;
  fallback: boolean;
}

export function mimeFromExtension(filename: string): MimeResult {
  // Operate on the basename so directory paths don't confuse extname.
  const base = basename(filename);
  // Dotfiles like ".bashrc" — extname returns "" — fall back.
  if (base.startsWith('.') && base.indexOf('.', 1) === -1) {
    return { mimeType: 'application/octet-stream', fallback: true };
  }
  const ext = extname(base).slice(1).toLowerCase();
  if (!ext) return { mimeType: 'application/octet-stream', fallback: true };
  const mimeType = TABLE[ext];
  if (mimeType !== undefined) return { mimeType, fallback: false };
  return { mimeType: 'application/octet-stream', fallback: true };
}
