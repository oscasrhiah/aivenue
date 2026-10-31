import { useState } from 'react';
import type { OutputFile, WorkflowRun } from '../../../core/src/types';
import { fileUrl, hub } from '../api';
import { useT } from '../i18n';
import { cx } from '../util';
import { Markdown } from './Markdown';

const IMG = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const fmt = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function Row({ f, onImage }: { f: OutputFile; onImage: (src: string) => void }) {
  const t = useT();
  const [preview, setPreview] = useState<{ text?: string; truncated?: boolean; error?: string } | null>(null);
  const isImg = !f.count && IMG.test(f.path) && !/\.svg$/i.test(f.path);
  const gone = f.status === 'deleted';
  const toggle = async () => {
    if (preview) return setPreview(null);
    try {
      setPreview(await hub.call('files.read', { path: f.abs }));
    } catch (e) {
      setPreview({ error: (e as Error).message });
    }
  };
  const label = f.status === 'added' ? t('新增', 'Added') : f.status === 'modified' ? t('修改', 'Modified') : t('刪除', 'Deleted');
  return (
    <div className="out-row">
      <div className="out-head">
        <span className={cx('out-status', f.status)}>{label}</span>
        {isImg && !gone ? <img className="out-thumb" src={fileUrl(f.abs)} alt="" onClick={() => onImage(fileUrl(f.abs))} /> : null}
        <span className={cx('out-path', gone && 'gone')}>
          {f.path}
          {f.count ? <span className="muted"> {t(`（${f.count.toLocaleString()} 個檔案）`, ` (${f.count.toLocaleString()} files)`)}</span> : null}
        </span>
        <span className="muted tiny">{fmt(f.size)}</span>
        {!gone && (
          <span className="out-actions">
            {!isImg && !f.count && (
              <button className="link" onClick={toggle}>
                {preview ? t('收起', 'Hide') : t('預覽', 'Preview')}
              </button>
            )}
            <button className="link" onClick={() => hub.call('files.open', { path: f.abs })}>
              {t('開啟', 'Open')}
            </button>
            <button className="link" onClick={() => hub.call('files.open', { path: f.abs, reveal: true })}>
              {t('所在資料夾', 'Folder')}
            </button>
          </span>
        )}
      </div>
      {preview && (
        <div className="out-preview">
          {preview.error ? (
            <span className="muted small">{preview.error}</span>
          ) : /\.(md|markdown)$/i.test(f.path) ? (
            <Markdown text={preview.text ?? ''} />
          ) : (
            <pre>{preview.text}</pre>
          )}
          {preview.truncated && <div className="muted tiny">{t('（只顯示前 200 KB）', '(first 200 KB only)')}</div>}
        </div>
      )}
    </div>
  );
}

/** Files the agents created / changed / deleted in the working folder during this run. */
export function Outputs({ run, onImage }: { run: WorkflowRun; onImage: (src: string) => void }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const list = run.outputs ?? [];
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 12);
  const n = (status: OutputFile['status']) => list.filter((f) => f.status === status).reduce((sum, f) => sum + (f.count ?? 1), 0);
  const counts = { added: n('added'), modified: n('modified'), deleted: n('deleted') };
  return (
    <div className="outputs">
      <div className="outputs-head fold-head" onClick={() => setOpen(!open)}>
        <span>
          <span className="chev">{open ? '▾' : '▸'}</span> 📁 {t('這次產生或修改的檔案', 'Files created or changed in this run')}
        </span>
        <span className="muted small">
          {[counts.added && t(`新增 ${counts.added}`, `${counts.added} added`), counts.modified && t(`修改 ${counts.modified}`, `${counts.modified} modified`), counts.deleted && t(`刪除 ${counts.deleted}`, `${counts.deleted} deleted`)].filter(Boolean).join(' · ')}
        </span>
      </div>
      {open && shown.map((f) => <Row key={f.path} f={f} onImage={onImage} />)}
      {open && list.length > shown.length && (
        <button className="link" onClick={() => setAll(true)}>
          {t(`顯示全部 ${list.length} 個`, `Show all ${list.length}`)}
        </button>
      )}
      {run.outputsTruncated && <div className="muted tiny">{t('資料夾檔案太多，只比對了前 5 萬個檔案。', 'Folder too large; only the first 50,000 files were compared.')}</div>}
    </div>
  );
}
