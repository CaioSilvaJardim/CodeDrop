/* =============================================
   CODEDROP — script.js
   ============================================= */

'use strict';

// ── CONFIG ─────────────────────────────────────
const DPASTE_API = 'https://dpaste.com/api/v2/';

const EXTENSIONS = [
  '.html', '.css', '.js', '.ts', '.tsx', '.jsx',
  '.json', '.md',  '.txt', '.vue', '.svelte',
  '.yaml', '.yml', '.xml', '.svg', '.env',
  '.gitignore', '.sh', '.py', '.rb', '.go',
  '.rs',  '.php', '.java', '.c',  '.cpp',
  '.h',   '.cs',  '.kt',  '.swift', '.toml',
  '.lock', '.ini', '.conf', '.dockerfile',
  '.prettierrc', '.eslintrc', '.babelrc',
];

// ── STATE ───────────────────────────────────────
let files       = {};   // { "path/to/file.ext": "content..." }
let folders     = {};   // { "path/": true } — collapsed/expanded state
let activeFile  = null; // currently previewed file path

// ── UTILS ───────────────────────────────────────
function isTextFile(name) {
  const lower = name.toLowerCase();
  // exact filenames with no extension
  const noExtNames = ['.gitignore', '.env', 'dockerfile', '.editorconfig',
                      '.prettierrc', '.eslintrc', '.babelrc', '.npmrc'];
  if (noExtNames.some(n => lower.endsWith(n))) return true;
  return EXTENSIONS.some(ext => lower.endsWith(ext));
}

function formatSize(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024*1024)  return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function totalSize() {
  return Object.values(files).reduce((s, c) => s + c.length, 0);
}

function fileExt(name) {
  const parts = name.split('.');
  return parts.length > 1 ? '.' + parts[parts.length - 1].toLowerCase() : '';
}

function fileIcon(name) {
  const ext = fileExt(name.split('/').pop());
  const map = {
    '.html': '🌐', '.css': '🎨', '.js': '📜', '.ts': '📘',
    '.tsx': '⚛️',  '.jsx': '⚛️', '.json': '📋', '.md': '📝',
    '.txt': '📄', '.vue': '💚', '.svelte': '🔥', '.yaml': '⚙️',
    '.yml': '⚙️', '.xml': '📰', '.svg': '🖼️', '.env': '🔐',
    '.sh':  '💻', '.py': '🐍',  '.rb': '💎', '.go': '🐹',
    '.rs':  '🦀', '.php': '🐘', '.java': '☕', '.c': '⚡',
    '.cpp': '⚡', '.cs': '🔷',  '.kt': '🟣', '.swift': '🍎',
  };
  return map[ext] || '📄';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── ROUTING ─────────────────────────────────────
function getRoute() {
  const path  = window.location.pathname;
  const match = path.match(/^\/v\/([a-zA-Z0-9]+)$/);
  return match ? { mode: 'view', binId: match[1] } : { mode: 'upload' };
}

// ── DPASTE API ───────────────────────────────────
async function saveToBin(data) {
  const compressed = LZString.compressToBase64(JSON.stringify(data));

  const formData = new URLSearchParams();
  formData.append('content', compressed);
  formData.append('syntax', 'text');
  formData.append('expiry_days', '2');

  const res = await fetch(DPASTE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  });

  if (!res.ok) throw new Error('Falha ao salvar: ' + res.status);

  // dpaste retorna a URL no corpo da resposta, ex: "https://dpaste.com/ABC123\n"
  const pasteUrl = await res.text();
  const pasteId  = pasteUrl.trim().split('/').pop();

  return pasteId;
}

async function loadFromBin(pasteId) {
  // dpaste serve conteúdo raw adicionando .txt no final
  const res = await fetch(`https://dpaste.com/${pasteId}.txt`);

  if (!res.ok) throw new Error('Paste não encontrado: ' + res.status);

  const compressed = await res.text();
  return JSON.parse(LZString.decompressFromBase64(compressed.trim()));
}

// ── ZIP PROCESSING ──────────────────────────────
async function processZip(file) {
  const zip = await JSZip.loadAsync(file);
  const out  = {};
  const promises = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir && isTextFile(relativePath)) {
      const p = entry.async('string').then(content => {
        // Strip leading __MACOSX or dot folders
        const clean = relativePath.replace(/^__MACOSX\//, '').replace(/^\._/, '');
        if (clean && !clean.startsWith('.')) {
          out[clean] = content;
        }
      });
      promises.push(p);
    }
  });
  await Promise.all(promises);
  return out;
}

// ── FOLDER ENTRY PROCESSING ─────────────────────
async function processEntry(entry, basePath) {
  const out = {};
  if (entry.isFile) {
    const file = await new Promise(res => entry.file(res));
    const fullPath = basePath + entry.name;
    if (isTextFile(fullPath)) {
      out[fullPath] = await file.text();
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries may return partial results — loop until empty
    let allEntries = [];
    await (async function readAll() {
      const batch = await new Promise(res => reader.readEntries(res));
      if (batch.length) {
        allEntries = allEntries.concat(Array.from(batch));
        await readAll();
      }
    })();
    for (const child of allEntries) {
      const sub = await processEntry(child, basePath + entry.name + '/');
      Object.assign(out, sub);
    }
  }
  return out;
}

// ── FILE HANDLING ───────────────────────────────
async function handleFiles(fileList) {
  const arr = Array.from(fileList);
  let added = 0;

  for (const file of arr) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      showToast('Descompactando ' + file.name + '…', 'info');
      try {
        const extracted = await processZip(file);
        const count = Object.keys(extracted).length;
        Object.assign(files, extracted);
        added += count;
      } catch (e) {
        showToast('Erro ao extrair ZIP: ' + e.message, 'error');
      }
    } else if (isTextFile(file.name)) {
      const content = await file.text();
      files[file.name] = content;
      added++;
    }
  }

  if (added > 0) {
    showToast(added + ' arquivo(s) adicionado(s)', 'success');
    renderWorkspace();
  } else {
    showToast('Nenhum arquivo de texto suportado encontrado', 'error');
  }
}

async function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');

  const items = e.dataTransfer.items;
  if (items && items.length > 0) {
    // Check for folder entries
    const entries = Array.from(items)
      .map(item => item.webkitGetAsEntry && item.webkitGetAsEntry())
      .filter(Boolean);

    if (entries.length > 0) {
      let added = 0;
      for (const entry of entries) {
        try {
          const result = await processEntry(entry, '');
          Object.assign(files, result);
          added += Object.keys(result).length;
        } catch (e2) {
          // fallback to file
        }
      }
      if (added > 0) {
        showToast(added + ' arquivo(s) adicionado(s)', 'success');
        renderWorkspace();
        return;
      }
    }
  }

  // Fallback
  if (e.dataTransfer.files.length) {
    await handleFiles(e.dataTransfer.files);
  }
}

// ── FILE TREE BUILDER ───────────────────────────
function buildTree(fileMap) {
  // Returns a sorted tree structure
  const tree = {};
  Object.keys(fileMap).sort().forEach(path => {
    const parts = path.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!node[dir]) node[dir] = { __isDir: true, __children: {} };
      node = node[dir].__children;
    }
    const fname = parts[parts.length - 1];
    node[fname] = { __isDir: false, __path: path };
  });
  return tree;
}

function renderTreeNode(node, prefix, depth) {
  let html = '';
  // Sort: folders first, then files
  const keys = Object.keys(node).sort((a, b) => {
    const aDir = node[a].__isDir;
    const bDir = node[b].__isDir;
    if (aDir && !bDir) return -1;
    if (!aDir && bDir) return 1;
    return a.localeCompare(b);
  });

  for (const key of keys) {
    const item  = node[key];
    const indent = depth * 18;

    if (item.__isDir) {
      const folderPath = prefix + key + '/';
      const isOpen = folders[folderPath] !== false; // default open
      html += `
        <div class="tree-item" data-folder="${escapeHtml(folderPath)}" onclick="toggleFolder(this, '${escapeHtml(folderPath)}')">
          <span class="tree-item-indent" style="width:${indent}px;display:inline-block"></span>
          <span class="tree-item-toggle ${isOpen ? 'open' : ''}">▶</span>
          <span class="tree-item-icon">📁</span>
          <span class="tree-item-name folder-name">${escapeHtml(key)}</span>
          <button class="tree-delete" onclick="deleteItem(event,'${escapeHtml(folderPath)}',true)" title="Deletar pasta">✕</button>
        </div>
        <div class="tree-subtree" data-subtree="${escapeHtml(folderPath)}" style="${isOpen ? '' : 'display:none'}">
          ${renderTreeNode(item.__children, folderPath, depth + 1)}
        </div>`;
    } else {
      const filePath = item.__path;
      const isActive = filePath === activeFile;
      html += `
        <div class="tree-item ${isActive ? 'active' : ''}" data-file="${escapeHtml(filePath)}" onclick="previewFile('${escapeHtml(filePath)}')">
          <span class="tree-item-indent" style="width:${indent + 14}px;display:inline-block"></span>
          <span class="tree-item-icon">${fileIcon(filePath)}</span>
          <span class="tree-item-name">${escapeHtml(key)}</span>
          <button class="tree-delete" onclick="deleteItem(event,'${escapeHtml(filePath)}',false)" title="Deletar arquivo">✕</button>
        </div>`;
    }
  }
  return html;
}

function toggleFolder(el, folderPath) {
  const toggle  = el.querySelector('.tree-item-toggle');
  const subtree = document.querySelector(`[data-subtree="${CSS.escape(folderPath)}"]`);
  if (!subtree) return;
  const isOpen = folders[folderPath] !== false;
  folders[folderPath] = !isOpen;
  if (folders[folderPath]) {
    subtree.style.display = '';
    toggle.classList.add('open');
  } else {
    subtree.style.display = 'none';
    toggle.classList.remove('open');
  }
}

function previewFile(path) {
  activeFile = path;
  // Update active state in tree
  document.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('active', el.dataset.file === path);
  });
  renderPreview();
}

function deleteItem(e, path, isFolder) {
  e.stopPropagation();
  if (isFolder) {
    Object.keys(files).forEach(f => {
      if (f.startsWith(path)) delete files[f];
    });
    if (activeFile && activeFile.startsWith(path)) activeFile = null;
  } else {
    delete files[path];
    if (activeFile === path) activeFile = null;
  }
  renderWorkspace();
}

// ── CREATE FOLDER MODAL ─────────────────────────
function showCreateFolder() {
  showModal(`
    <div class="modal-header">
      <span class="modal-title">Nova Pasta</span>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <p class="text-secondary" style="margin-bottom:16px;font-size:13px;">
        Digite o caminho da pasta (ex: <span class="mono text-accent">src/components</span>)
      </p>
      <input class="input-field" id="folder-name-input" placeholder="src/components" autocomplete="off" />
      <div style="margin-top:16px;display:flex;gap:10px;">
        <button class="btn btn-primary w-full" onclick="createFolder()">Criar Pasta</button>
        <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      </div>
    </div>
  `);
  setTimeout(() => {
    const inp = document.getElementById('folder-name-input');
    if (inp) {
      inp.focus();
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') createFolder(); });
    }
  }, 50);
}

function createFolder() {
  const inp = document.getElementById('folder-name-input');
  if (!inp) return;
  let name = inp.value.trim().replace(/^\/|\/$/g, '');
  if (!name) { showToast('Digite um nome para a pasta', 'error'); return; }
  // Create a placeholder .gitkeep file
  const placeholder = name + '/.gitkeep';
  files[placeholder] = '';
  closeModal();
  showToast('Pasta "' + name + '" criada', 'success');
  renderWorkspace();
}

// ── RENDER WORKSPACE ────────────────────────────
function renderWorkspace() {
  const app   = document.getElementById('app');
  const count = Object.keys(files).length;
  const size  = formatSize(totalSize());

  if (count === 0) {
    renderUploadMode();
    return;
  }

  const tree = buildTree(files);
  const treeHtml = renderTreeNode(tree, '', 0);

  app.innerHTML = `
    <div class="upload-mode">
      <div class="upload-mode-header">
        <h1>Seus Arquivos</h1>
        <p>Arraste mais arquivos, crie pastas ou gere o link de compartilhamento</p>
      </div>

      <!-- Upload Area (compact) -->
      <div class="upload-area" id="upload-area" style="padding:32px 24px;margin-bottom:20px;">
        <input type="file" id="file-input" multiple accept="*" />
        <div class="upload-icon" style="font-size:28px;margin-bottom:8px;">📂</div>
        <div class="upload-title" style="font-size:14px;margin-bottom:4px;">Adicionar mais arquivos</div>
        <div class="upload-sub" style="font-size:12px;">Arraste arquivos, pastas ou .zip</div>
      </div>

      <!-- Workspace -->
      <div class="workspace">
        <!-- File Tree Panel -->
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">Arquivos (${count})</span>
            <button class="btn btn-ghost btn-sm" onclick="showCreateFolder()" title="Nova Pasta">
              + Pasta
            </button>
          </div>
          <div class="panel-body">
            <div class="file-tree" id="file-tree">
              ${treeHtml || '<div class="tree-empty">Sem arquivos</div>'}
            </div>
          </div>
          <div class="panel-footer">
            <span class="panel-footer-info">${count} arquivo(s) · ${size}</span>
            <button class="btn btn-danger btn-sm" onclick="clearAll()">Limpar tudo</button>
          </div>
        </div>

        <!-- Preview Panel -->
        <div class="panel preview-panel" id="preview-panel">
          ${renderPreviewHTML()}
        </div>
      </div>

      <!-- Generate Link -->
      <div class="generate-section">
        <button class="btn btn-secondary" onclick="renderUploadMode()">← Voltar</button>
        <button class="btn btn-primary btn-lg" onclick="generateLink()" id="gen-btn">
          ⚡ Gerar Link
        </button>
      </div>
    </div>
  `;

  attachUploadEvents();
}

function renderPreviewHTML() {
  if (!activeFile || !files[activeFile]) {
    return `
      <div class="preview-empty">
        <div class="preview-empty-icon">👈</div>
        <div class="preview-empty-text text-muted">Clique em um arquivo para visualizar</div>
      </div>`;
  }
  return `
    <div class="preview-header">
      <span class="preview-filename">${escapeHtml(activeFile)}</span>
      <button class="btn btn-ghost btn-sm" onclick="activeFile=null;renderPreview()">✕ Fechar</button>
    </div>
    <pre class="code-block">${escapeHtml(files[activeFile])}</pre>`;
}

function renderPreview() {
  const panel = document.getElementById('preview-panel');
  if (panel) panel.innerHTML = renderPreviewHTML();
}

function clearAll() {
  if (!confirm('Limpar todos os arquivos?')) return;
  files = {};
  activeFile = null;
  renderUploadMode();
}

// ── RENDER UPLOAD MODE ───────────────────────────
function renderUploadMode() {
  activeFile = null;
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="upload-mode">
      <div class="upload-mode-header">
        <h1>Compartilhe seu Código</h1>
        <p>Faça upload de arquivos, pastas ou .zip e gere um link curto para compartilhar</p>
      </div>

      <div class="upload-area" id="upload-area">
        <input type="file" id="file-input" multiple accept="*" />
        <div class="upload-icon">📂</div>
        <div class="upload-title">Arraste arquivos ou .zip aqui</div>
        <div class="upload-sub">ou clique para selecionar</div>
        <div class="upload-exts">
          ${['html','css','js','ts','tsx','jsx','json','md','txt','vue','svelte','yaml','py','go','rs'].map(e =>
            `<span class="ext-badge">.${e}</span>`).join('')}
          <span class="ext-badge">+ mais</span>
        </div>
      </div>
    </div>
  `;
  attachUploadEvents();
}

function attachUploadEvents() {
  const area  = document.getElementById('upload-area');
  const input = document.getElementById('file-input');
  if (!area || !input) return;

  area.addEventListener('dragover', e => {
    e.preventDefault();
    area.classList.add('dragover');
  });
  area.addEventListener('dragleave', e => {
    if (!area.contains(e.relatedTarget)) area.classList.remove('dragover');
  });
  area.addEventListener('drop', handleDrop);

  input.addEventListener('change', e => {
    if (e.target.files.length) handleFiles(e.target.files);
    input.value = '';
  });
}

// ── GENERATE LINK ───────────────────────────────
async function generateLink() {
  const btn   = document.getElementById('gen-btn');
  const count = Object.keys(files).length;
  if (count === 0) { showToast('Adicione arquivos primeiro', 'error'); return; }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvando…'; }

  try {
    const binId = await saveToBin(files);
    const link  = window.location.origin + '/v/' + binId;
    showLinkModal(link, count, formatSize(totalSize()));
    showToast('Link gerado com sucesso!', 'success');
  } catch (err) {
    showToast('Erro ao gerar link: ' + err.message, 'error');
  }

  if (btn) { btn.disabled = false; btn.innerHTML = '⚡ Gerar Link'; }
}

function showLinkModal(link, count, size) {
  showModal(`
    <div class="modal-header">
      <span class="modal-title">✅ Link Gerado</span>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="link-display" id="generated-link">${escapeHtml(link)}</div>
      <div class="modal-actions">
        <button class="btn btn-primary w-full btn-lg" onclick="copyLink('${escapeHtml(link)}')">
          📋 Copiar Link
        </button>
        <a href="${escapeHtml(link)}" target="_blank" class="btn btn-secondary w-full" style="justify-content:center;">
          🔗 Abrir Link
        </a>
      </div>
      <div class="modal-meta">${count} arquivo(s) · ${size}</div>
    </div>
  `);
}

function copyLink(link) {
  navigator.clipboard.writeText(link).then(() => {
    showToast('Link copiado!', 'success');
  });
}

// ── VIEW MODE ────────────────────────────────────
async function renderViewMode(binId) {
  const app    = document.getElementById('app');
  const header = document.getElementById('header-actions');

  // Header button
  header.innerHTML = `<a href="/" class="btn btn-secondary">+ Criar novo drop</a>`;

  // Loading
  app.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <div class="loading-text">Carregando arquivos…</div>
    </div>`;

  try {
    const data = await loadFromBin(binId);
    files = data;

    const count = Object.keys(files).length;
    const size  = formatSize(totalSize());
    const sorted = Object.keys(files).sort();

    // Build file blocks HTML
    let blocksHtml = '';
    for (const path of sorted) {
      const content = files[path];
      const lang    = getLangFromPath(path);
      blocksHtml += `
        <div class="file-block">
          <div class="file-block-header">
            <span style="color:var(--text-muted);font-size:12px;">═══</span>
            <span class="file-block-name">${escapeHtml(path)}</span>
            <div class="file-block-separator"></div>
            <button class="file-block-copy" onclick="copyFileContent('${escapeHtml(path)}')">
              📋 Copiar
            </button>
          </div>
          <pre class="code-block">${escapeHtml(content)}</pre>
        </div>`;
    }

    app.innerHTML = `
      <div class="view-mode">
        <div class="view-header">
          <div class="view-meta">
            <span class="view-meta-info">${count} arquivo(s) · ${size}</span>
            <span class="view-meta-info text-muted">ID: ${escapeHtml(binId)}</span>
          </div>
          <div class="view-actions">
            <button class="btn btn-secondary" onclick="copyAllText()">📄 Copiar Texto</button>
            <button class="btn btn-secondary" onclick="copyAllMarkdown()">📝 Copiar Markdown</button>
          </div>
        </div>
        <div class="file-blocks">${blocksHtml}</div>
      </div>`;

  } catch (err) {
    app.innerHTML = `
      <div class="error-state">
        <div class="error-icon">💀</div>
        <div class="error-title">Oops! Drop não encontrado</div>
        <div class="error-msg">${escapeHtml(err.message)}</div>
        <a href="/" class="btn btn-primary" style="margin-top:16px;">← Criar novo drop</a>
      </div>`;
  }
}

function getLangFromPath(path) {
  const ext = fileExt(path.split('/').pop());
  const map = {
    '.js':'javascript','.ts':'typescript','.tsx':'tsx','.jsx':'jsx',
    '.html':'html','.css':'css','.json':'json','.md':'markdown',
    '.py':'python','.rb':'ruby','.go':'go','.rs':'rust',
    '.java':'java','.c':'c','.cpp':'cpp','.cs':'csharp',
    '.php':'php','.sh':'bash','.yaml':'yaml','.yml':'yaml',
    '.xml':'xml','.svg':'xml','.vue':'vue','.svelte':'svelte',
    '.txt':'',
  };
  return map[ext] || '';
}

function copyFileContent(path) {
  const content = files[path] || '';
  navigator.clipboard.writeText(content).then(() => {
    showToast('Conteúdo de ' + path.split('/').pop() + ' copiado!', 'success');
  });
}

function copyAllText() {
  const sorted = Object.keys(files).sort();
  const parts  = sorted.map(path =>
    `=== ${path} ===\n${files[path]}`
  );
  navigator.clipboard.writeText(parts.join('\n\n')).then(() => {
    showToast('Todos os arquivos copiados como texto!', 'success');
  });
}

function copyAllMarkdown() {
  const sorted = Object.keys(files).sort();
  const parts  = sorted.map(path => {
    const lang = getLangFromPath(path);
    return `# ${path}\n\`\`\`${lang}\n${files[path]}\n\`\`\``;
  });
  navigator.clipboard.writeText(parts.join('\n\n')).then(() => {
    showToast('Todos os arquivos copiados como Markdown!', 'success');
  });
}

// ── MODAL ────────────────────────────────────────
function showModal(html) {
  const overlay = document.getElementById('modal-overlay');
  const box     = document.getElementById('modal-box');
  box.innerHTML = html;
  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
});

// ── TOAST ────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = 'toast ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ── INIT ─────────────────────────────────────────
function init() {
  const route = getRoute();
  if (route.mode === 'view') {
    renderViewMode(route.binId);
  } else {
    renderUploadMode();
  }
}

// Handle browser back/forward
window.addEventListener('popstate', init);

document.addEventListener('DOMContentLoaded', init);
