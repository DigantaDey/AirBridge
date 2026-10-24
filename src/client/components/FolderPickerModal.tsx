import { useEffect, useState } from 'react';

interface FsEntry {
  name: string;
  isDirectory: boolean;
  path: string;
}
interface FsListResponse {
  current: string;
  parent: string | null;
  home: string;
  downloadDir: string;
  entries: FsEntry[];
}

interface FolderPickerModalProps {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderPickerModal({ initialPath, onSelect, onClose }: FolderPickerModalProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [manualEdit, setManualEdit] = useState(initialPath);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [home, setHome] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchList = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`);
      const json = (await resp.json()) as FsListResponse & { error?: string };
      if (!resp.ok) throw new Error(json.error || 'Cannot list directory');
      setCurrentPath(json.current);
      setManualEdit(json.current);
      setEntries(json.entries);
      setParent(json.parent);
      setHome(json.home);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot list directory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchList(initialPath || home).catch(() => {});
  }, []);

  const handleNavigate = (path: string) => {
    fetchList(path).catch(() => {});
  };

  const handleManualGo = () => {
    const trimmed = manualEdit.trim();
    if (!trimmed) return;
    fetchList(trimmed).catch(() => {});
  };

  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const resp = await fetch('/api/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: currentPath, name: trimmed }),
      });
      const json = (await resp.json()) as { path?: string; error?: string };
      if (!resp.ok) throw new Error(json.error || 'Cannot create folder');
      setNewFolderName('');
      await fetchList(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot create folder');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="utility-modal folder-picker-modal" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title">
        <div className="modal-heading">
          <div>
            <p className="section-kicker">CHOOSE FOLDER</p>
            <h2 id="folder-picker-title">Received files folder</h2>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="modal-explainer">Browse to choose where AirBridge saves received files. You can also paste or edit the path manually.</p>

        <div className="folder-picker-path-row">
          <input
            aria-label="Folder path"
            value={manualEdit}
            onChange={(e) => setManualEdit(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleManualGo(); }}
            placeholder="~/Downloads/AirBridge"
          />
          <button type="button" className="secondary-button" onClick={handleManualGo}>Go</button>
        </div>

        <div className="folder-picker-breadcrumbs">
          <span className="folder-picker-current" title={currentPath}>{currentPath}</span>
          <div className="folder-picker-shortcuts">
            {home && <button type="button" className="text-button" onClick={() => handleNavigate(home)}>Home</button>}
            {parent && <button type="button" className="text-button" onClick={() => handleNavigate(parent)}>↑ Parent</button>}
          </div>
        </div>

        {error && <p className="clipboard-error" role="alert">{error}</p>}
        {loading ? (
          <p className="folder-picker-loading">Loading…</p>
        ) : (
          <div className="folder-picker-list">
            {entries.length === 0 ? (
              <p className="empty-history">No subfolders here. You can select this folder or create a new one.</p>
            ) : (
              <ul>
                {entries.map((e) => (
                  <li key={e.path}>
                    <button type="button" className="folder-entry-button" onClick={() => handleNavigate(e.path)}>
                      <span className="folder-entry-icon" aria-hidden="true">📁</span>
                      <span>{e.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="folder-picker-create">
          <input
            placeholder="New folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); }}
          />
          <button type="button" className="quiet-button" disabled={!newFolderName.trim() || creating} onClick={handleCreateFolder}>
            {creating ? 'Creating…' : 'New folder'}
          </button>
        </div>

        <div className="folder-picker-actions">
          <button type="button" className="quiet-button" onClick={onClose}>Cancel</button>
          <button type="button" className="secondary-button" onClick={() => onSelect(currentPath)}>Select this folder</button>
        </div>
        <small className="selection-hint">Selected folder will be used for the next received file. Only changeable from this device.</small>
      </section>
    </div>
  );
}
