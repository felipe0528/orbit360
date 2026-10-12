(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const token = document.querySelector('meta[name="orbit-token"]').content;
  const ui = { state: { assets: [], jobs: [], plan: null, capabilities: {} }, selected: new Set(), assetId: null, clipIndex: -1, view: 'video', busy: false, disconnected: false, snapshot: '' };
  const labels = { queued: 'En cola', running: 'En curso', complete: 'Completado', failed: 'Error', cancelled: 'Cancelado' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const seconds = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const time = value => { const ms = Math.round(Math.max(0, seconds(value)) * 1000); const fraction = ms % 1000 ? `,${String(ms % 1000).padStart(3, '0').replace(/0+$/, '')}` : ''; return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${fraction}`; };
  const asset = id => ui.state.assets.find(a => a.id === id);
  const currentAsset = () => asset(ui.assetId);
  const currentClip = () => ui.state.plan?.clips?.[ui.clipIndex];
  const mediaUrl = (kind, id, extra = '') => `/api/${kind}/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}${extra}`;
  const hasActiveJob = type => ui.state.jobs.some(j => (!type || j.type === type) && ['queued', 'running'].includes(j.status));

  function notice(message, error = false) { $('notice-text').textContent = message; $('notice').hidden = false; $('notice').classList.toggle('error', error); if ($('import-dialog').open) { $('import-status').textContent = message; $('import-status').hidden = false; } }
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'X-Orbit-Token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    let data;
    try { data = await response.json(); } catch { throw new Error('El servidor devolvió una respuesta que no se pudo leer.'); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.message || data.error?.message || `Error ${response.status}`);
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  async function action(button, fn) { if (button?.disabled || ui.busy) return; ui.busy = true; if (button) button.disabled = true; updateButtons(); try { await fn(); } catch (error) { notice(error.message, true); } finally { ui.busy = false; if (button) button.disabled = false; updateButtons(); } }

  function updateButtons() {
    const selected = ui.selected.size > 0;
    $('manual-plan').disabled = !selected || ui.busy;
    $('generate-plan').disabled = !selected || !ui.state.capabilities.codex || hasActiveJob() || ui.busy;
    $('generate-plan').textContent = hasActiveJob('plan') ? 'Codex está preparando el montaje…' : 'Proponer montaje ↗';
    $('export').disabled = !ui.state.plan?.clips?.length || hasActiveJob() || ui.busy;
    $('prepare-asset').disabled = !ui.state.capabilities.sdk || hasActiveJob() || ui.busy;
    $('duplicate-clip').disabled = !currentClip() || (ui.state.plan?.clips?.length || 0) >= 100 || ui.busy;
    $('split-clip').disabled = !currentClip() || (ui.state.plan?.clips?.length || 0) >= 100 || ui.busy;
    $('move-clip-before').disabled = !currentClip() || ui.clipIndex === 0 || ui.busy;
    $('move-clip-after').disabled = !currentClip() || ui.clipIndex === (ui.state.plan?.clips?.length || 0) - 1 || ui.busy;
    $('output-preset').disabled = !ui.state.plan;
    $('output-fps').disabled = !ui.state.plan;
    $('select-all').checked = ui.state.assets.length > 0 && ui.selected.size === ui.state.assets.length;
    $('select-all').indeterminate = ui.selected.size > 0 && ui.selected.size < ui.state.assets.length;
    $('codex-status').classList.toggle('ready', Boolean(ui.state.capabilities.codex));
    $('codex-status').title = ui.state.capabilities.codex ? 'Codex disponible' : 'Codex no disponible. Ejecuta codex login y reinicia la aplicación.';
    for (const [id, available, label] of [['ffmpeg-cap', ui.state.capabilities.ffmpeg, 'FFmpeg'], ['sdk-cap', ui.state.capabilities.sdk, 'Media SDK']]) { $(id).textContent = `${label} · ${available ? 'disponible' : 'no disponible'}`; $(id).classList.toggle('unavailable', !available); }
  }

  function renderAssets() {
    $('asset-count').textContent = ui.state.assets.length;
    $('asset-list').innerHTML = ui.state.assets.length ? ui.state.assets.map(a => `<article class="asset-card ${a.id === ui.assetId ? 'active' : ''}" data-asset="${esc(a.id)}" tabindex="0" aria-label="Ver ${esc(a.name)}"><input type="checkbox" aria-label="Seleccionar ${esc(a.name)}" data-select="${esc(a.id)}" ${ui.selected.has(a.id) ? 'checked' : ''}><div class="asset-icon" aria-hidden="true">${a.projection === 'flat' ? '▶' : '360°'}</div><div><div class="asset-title" title="${esc(a.name)}">${esc(a.name)}</div><div class="asset-meta">${time(a.duration)} · ${a.width || '—'} × ${a.height || '—'}</div><div class="asset-prep">${a.projection === 'insv' ? (a.ready ? '360° preparado' : 'INSV · por preparar') : a.projection === 'equirectangular' ? '360° equirectangular' : 'Vídeo plano'}</div></div></article>`).join('') : '<div class="library-empty"><div class="empty-mark" aria-hidden="true">＋</div>Tu biblioteca está lista.<br>Añade el material de tu próxima historia.</div>';
    updateButtons();
  }

  function renderPreview(force = false) {
    const a = currentAsset();
    const ready = a && (a.projection !== 'insv' || a.ready);
    $('preview-empty').hidden = Boolean(a);
    $('prepare-overlay').hidden = !a || ready;
    $('video').hidden = !ready || ui.view !== 'video';
    $('frame').hidden = !ready || ui.view !== 'frame';
    $('frame-controls').hidden = !ready || ui.view !== 'frame';
    $('preview-badge').hidden = !a;
    $('preview-title').textContent = a?.name || 'Una historia. Todos los ángulos.';
    $('preview-meta').textContent = a ? `${a.width || '—'} × ${a.height || '—'} · ${Number(a.fps || 0).toFixed(2).replace(/\.00$/, '')} fps · ${time(a.duration)}` : 'INSV · MP4 · MOV';
    $('preview-badge').textContent = a?.projection === 'flat' ? 'VÍDEO PLANO' : '360°';
    $('video-mode').classList.toggle('active', ui.view === 'video');
    $('frame-mode').classList.toggle('active', ui.view === 'frame');
    $('video-mode').setAttribute('aria-pressed', String(ui.view === 'video'));
    $('frame-mode').setAttribute('aria-pressed', String(ui.view === 'frame'));
    const out = ui.state.plan?.output;
    $('preview-note').textContent = ui.view === 'frame' ? `Fotograma de encuadre ${out ? `${out.width} × ${out.height}` : '16:9'} · sin montaje` : 'Vista previa del material original';
    $('prepare-asset').disabled = !ui.state.capabilities.sdk || hasActiveJob() || ui.busy;
    $('prepare-hint').textContent = ui.state.capabilities.sdk ? 'La preparación puede tardar. Sigue el avance en Actividad.' : 'Configura el Media SDK o importa un MP4 360° exportado desde Studio.';
    if (ready && ui.view === 'video') {
      const next = mediaUrl('media', a.id);
      if ($('video').getAttribute('src') !== next || force) { $('video').src = next; $('video').load(); }
    } else { $('video').pause(); }
    if (ready && ui.view === 'frame') loadFrame();
  }

  function loadFrame() {
    const a = currentAsset(); if (!a) return;
    const clip = currentClip()?.assetId === a.id ? currentClip() : null;
    const out = ui.state.plan?.output || { width: 1920, height: 1080 };
    const params = new URLSearchParams({ time: String(Math.max(0, Math.min(seconds($('frame-time').value), Math.max(0, seconds(a.duration) - .05)))), yaw: String(clip?.yaw ?? 0), pitch: String(clip?.pitch ?? 0), fov: String(clip?.fov ?? 90), width: String(out.width), height: String(out.height), projection: out.projection || 'flat' });
    $('frame').src = mediaUrl('frame', a.id, `&${params}`);
  }

  function renderPlan() {
    const plan = ui.state.plan;
    $('plan-title').textContent = plan?.title || 'El lienzo de tu historia';
    $('plan-explanation').textContent = plan?.explanation || 'Construye un montaje manual o pide una propuesta a Codex.';
    const clips = plan?.clips || [];
    $('clip-count').textContent = `${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}`;
    $('plan-duration').textContent = time(clips.reduce((sum, clip) => sum + (clip.end - clip.start) / (clip.speed || 1), 0));
    $('clip-list').innerHTML = clips.length ? clips.map((clip, i) => `<button class="timeline-clip ${ui.clipIndex === i ? 'active' : ''}" data-clip="${i}" aria-label="Editar clip ${i + 1}"><div class="clip-top"><span>${String(i + 1).padStart(2, '0')}</span><span>${time((clip.end - clip.start) / (clip.speed || 1))}</span></div><div class="clip-name">${esc(asset(clip.assetId)?.name || 'Material no encontrado')}</div><div class="clip-bottom">${time(clip.start)} → ${time(clip.end)} · ${clip.speed || 1}×${clip.mute ? ' · sin audio' : ''}</div></button>`).join('') : '<div class="timeline-empty"><span aria-hidden="true">＋</span> Tus cortes y encuadres aparecerán aquí</div>';
    if (plan) {
      const out = plan.output;
      $('output-preset').value = out.projection === 'equirectangular' ? '360' : out.width * 4 === out.height * 3 ? 'portrait34' : out.width > out.height ? 'landscape' : out.width < out.height ? 'portrait' : 'square';
      if (![...$('output-fps').options].some(o => Number(o.value) === out.fps)) $('output-fps').add(new Option(String(out.fps), String(out.fps)));
      $('output-fps').value = String(out.fps);
    }
    $('output-hint').hidden = plan?.output.projection !== 'equirectangular';
    renderInspector(); updateButtons();
  }

  function renderInspector() {
    const clip = currentClip();
    $('inspector-empty').hidden = Boolean(clip); $('clip-inspector').hidden = !clip;
    $('inspector-title').textContent = clip ? `Clip ${String(ui.clipIndex + 1).padStart(2, '0')} · Ajusta el punto de vista` : 'Hazlo tuyo';
    if (!clip) return;
    for (const key of ['start', 'end', 'yaw', 'pitch', 'fov', 'speed']) $('clip-inspector').elements.namedItem(key).value = clip[key] ?? ({ yaw: 0, pitch: 0, fov: 90, speed: 1 }[key] || 0);
    $('clip-inspector').elements.namedItem('mute').checked = Boolean(clip.mute);
    $('move-clip-before').disabled = ui.clipIndex === 0;
    $('move-clip-after').disabled = ui.clipIndex === ui.state.plan.clips.length - 1;
    $('duplicate-clip').disabled = ui.state.plan.clips.length >= 100;
    $('split-time').value = Number(((clip.start + clip.end) / 2).toFixed(6));
  }

  function renderJobs() {
    const jobs = [...ui.state.jobs].reverse().slice(0, 8);
    $('job-panel').hidden = jobs.length === 0;
    $('jobs').innerHTML = jobs.map(j => {
      const active = ['queued', 'running'].includes(j.status);
      const value = j.progress == null ? null : Math.max(0, Math.min(100, Number(j.progress) || 0));
      return `<article class="job ${esc(j.status)}"><div class="job-top"><span class="job-name">${esc(({ plan: 'Propuesta de Codex', prepare: 'Preparación de INSV', export: 'Exportación de vídeo' })[j.type] || j.type)}</span><span>${esc(labels[j.status] || j.status)}${active && value !== null ? ` · ${Math.round(value)}%` : ''}</span></div><p class="job-message">${esc(j.error || j.message || '')}</p>${j.status === 'complete' && j.type === 'export' && j.result?.spherical?.verified === true ? '<p class="job-spherical">360° · Metadatos esféricos verificados en el MP4. Listo para subir a YouTube o usar en VR.</p>' : ''}${active ? `<progress max="100" ${value !== null ? `value="${value}"` : ''} aria-label="Progreso"></progress>` : ''}<div class="job-actions">${active ? `<button class="quiet" data-cancel="${esc(j.id)}">Cancelar tarea</button>` : ''}${j.status === 'complete' && j.type === 'export' ? `<a href="${esc(mediaUrl('exports', j.id))}" target="_blank" rel="noopener">Reproducir ↗</a><a href="${esc(mediaUrl('exports', j.id, '&download=1'))}" download>Descargar vídeo</a>` : ''}</div></article>`;
    }).join('');
    updateButtons();
  }

  function acceptState(next) {
    const previous = ui.state;
    ui.state = { ...ui.state, ...next, assets: next.assets || ui.state.assets, jobs: next.jobs || ui.state.jobs, capabilities: next.capabilities || ui.state.capabilities };
    ui.selected = new Set([...ui.selected].filter(id => asset(id)));
    if (!currentAsset() && ui.state.assets.length) ui.assetId = ui.state.assets[0].id;
    const assetsChanged = JSON.stringify(previous.assets) !== JSON.stringify(ui.state.assets);
    const planChanged = JSON.stringify(previous.plan) !== JSON.stringify(ui.state.plan);
    if (assetsChanged) { renderAssets(); renderPreview(); }
    if (planChanged) { ui.clipIndex = ui.state.plan?.clips?.length ? Math.max(0, Math.min(ui.clipIndex, ui.state.plan.clips.length - 1)) : -1; if (currentClip()) { ui.assetId = currentClip().assetId; $('frame-time').value = currentClip().start; } renderPlan(); renderAssets(); renderPreview(); }
    if (JSON.stringify(previous.jobs) !== JSON.stringify(ui.state.jobs)) renderJobs();
    updateButtons();
  }

  async function refresh() {
    try { const next = await api('/api/state'); acceptState(next); if (ui.disconnected) { ui.disconnected = false; notice('Conexión con el estudio restablecida.'); } }
    catch (error) { if (!ui.disconnected) notice(`No se puede conectar con el estudio. ${error.message}`, true); ui.disconnected = true; }
  }

  async function savePlan(plan) {
    const result = await api('/api/plan', { method: 'PUT', body: JSON.stringify({ plan }) });
    ui.state.plan = result.plan || plan; renderPlan();
  }
  function editedClip() {
    const clip = structuredClone(currentClip());
    const form = $('clip-inspector');
    for (const key of ['start', 'end', 'yaw', 'pitch', 'fov', 'speed']) clip[key] = Number(form.elements.namedItem(key).value);
    clip.mute = form.elements.namedItem('mute').checked;
    if (clip.end - clip.start < .1 - 1e-9) throw new Error('Cada segmento debe durar al menos 0,1 segundos en el original.');
    if (clip.end > seconds(asset(clip.assetId)?.duration) + .03) throw new Error('La salida supera la duración del vídeo.');
    return clip;
  }
  function selectClip(index) { ui.clipIndex = index; const clip = currentClip(); if (clip) { ui.assetId = clip.assetId; $('frame-time').value = clip.start; } renderPlan(); renderAssets(); renderPreview(); if (ui.view === 'video' && currentAsset()?.ready !== false) { try { $('video').currentTime = clip.start; } catch {} } }
  function openImport() { $('import-status').hidden = true; $('import-dialog').showModal(); $('import-paths').focus(); }

  $('open-import').onclick = openImport; $('empty-import').onclick = openImport;
  $('close-import').onclick = $('cancel-import').onclick = () => $('import-dialog').close();
  $('dismiss-notice').onclick = () => { $('notice').hidden = true; };
  $('scan').onclick = () => action($('scan'), async () => { const directory = $('scan-directory').value.trim(); if (!directory) throw new Error('Introduce la ruta de una carpeta.'); const data = await post('/api/scan', { directory }); $('import-paths').value = data.paths.join('\n'); if (!data.paths.length) notice('No se encontraron archivos INSV en la carpeta.'); else if (data.truncated) notice('La búsqueda alcanzó su límite. Se muestran los primeros archivos encontrados; elige una carpeta más concreta para buscar otros.'); });
  $('import-form').onsubmit = event => { event.preventDefault(); action($('confirm-import'), async () => { const paths = $('import-paths').value.split(/\r?\n/).map(p => p.trim().replace(/^"|"$/g, '')).filter(Boolean); if (!paths.length) throw new Error('Introduce al menos una ruta de vídeo.'); const previousIds = new Set(ui.state.assets.map(a => a.id)); const next = await post('/api/import', { paths, projection: $('import-projection').value }); acceptState(next); for (const a of ui.state.assets) if (!previousIds.has(a.id)) ui.selected.add(a.id); renderAssets(); $('import-dialog').close(); notice('Material importado. Selecciona los clips para crear tu montaje.'); }); };
  $('asset-list').addEventListener('click', event => { const checkbox = event.target.closest('[data-select]'); if (checkbox) { if (checkbox.checked) ui.selected.add(checkbox.dataset.select); else ui.selected.delete(checkbox.dataset.select); updateButtons(); return; } const card = event.target.closest('[data-asset]'); if (card) { ui.assetId = card.dataset.asset; ui.clipIndex = -1; $('frame-time').value = 0; renderAssets(); renderPlan(); renderPreview(); } });
  $('asset-list').addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key) && event.target.matches('[data-asset]')) { event.preventDefault(); event.target.click(); } });
  $('select-all').onchange = event => { ui.selected = new Set(event.target.checked ? ui.state.assets.map(a => a.id) : []); renderAssets(); };
  $('manual-plan').onclick = () => action($('manual-plan'), async () => { const result = await post('/api/default-plan', { assetIds: [...ui.selected] }); ui.state.plan = result.plan; ui.clipIndex = 0; renderPlan(); selectClip(0); notice('Montaje creado. Ajusta cada clip y el formato de salida.'); });
  $('generate-plan').onclick = () => action($('generate-plan'), async () => { const prompt = $('prompt').value.trim(); if (!prompt) throw new Error('Describe primero el vídeo que quieres crear.'); await post('/api/plan', { prompt, assetIds: [...ui.selected], model: $('model').value.trim(), includeFrames: $('include-frames').checked }); await refresh(); notice('Codex está preparando una propuesta. Podrás revisarla antes de exportar.'); });
  document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); }; });
  $('prepare-asset').onclick = () => action($('prepare-asset'), async () => { await post('/api/prepare', { assetId: ui.assetId }); await refresh(); renderPreview(); });
  $('video-mode').onclick = () => { ui.view = 'video'; renderPreview(); };
  $('frame-mode').onclick = () => { ui.view = 'frame'; renderPreview(); };
  $('refresh-frame').onclick = loadFrame;
  $('frame').onerror = () => { if (ui.view === 'frame') notice('No se pudo generar el fotograma. Comprueba que el material esté preparado y que FFmpeg esté disponible.', true); };
  $('video').onerror = () => { if (ui.view === 'video' && currentAsset()) notice('Este formato no se puede reproducir en el navegador. Usa la vista Encuadre para revisar un fotograma.', true); };
  $('clip-list').onclick = event => { const clip = event.target.closest('[data-clip]'); if (clip) selectClip(Number(clip.dataset.clip)); };
  $('clip-inspector').onsubmit = event => { event.preventDefault(); action(event.submitter, async () => { const plan = structuredClone(ui.state.plan); const clip = editedClip(); plan.clips[ui.clipIndex] = clip; await savePlan(plan); $('frame-time').value = clip.start; if (ui.view === 'frame') loadFrame(); notice('Ajustes del clip guardados.'); }); };
  $('split-clip').onclick = () => { if (!$('clip-inspector').reportValidity()) return; action($('split-clip'), async () => { const plan = structuredClone(ui.state.plan); const clip = editedClip(); const split = Number($('split-time').value); if (!$('split-time').value.trim() || !Number.isFinite(split) || split <= clip.start || split >= clip.end) throw new Error('El punto de división debe estar entre la entrada y la salida del clip.'); if (split - clip.start < .1 - 1e-9 || clip.end - split < .1 - 1e-9) throw new Error('Deja al menos 0,1 segundos del original a cada lado de la división.'); if (plan.clips.length >= 100) throw new Error('El montaje admite un máximo de 100 clips.'); plan.clips.splice(ui.clipIndex, 1, { ...clip, end: split }, { ...clip, start: split }); await savePlan(plan); selectClip(ui.clipIndex); notice(`Clip dividido en ${time(split)}. Ambos segmentos conservan encuadre, velocidad y audio.`); }); };
  $('remove-clip').onclick = () => action($('remove-clip'), async () => { const plan = structuredClone(ui.state.plan); if (plan.clips.length === 1) throw new Error('El montaje necesita al menos un clip. Crea otro montaje desde la biblioteca para reemplazarlo.'); plan.clips.splice(ui.clipIndex, 1); ui.clipIndex = Math.min(ui.clipIndex, plan.clips.length - 1); await savePlan(plan); selectClip(ui.clipIndex); });
  $('duplicate-clip').onclick = () => action($('duplicate-clip'), async () => { const plan = structuredClone(ui.state.plan); plan.clips.splice(ui.clipIndex + 1, 0, structuredClone(plan.clips[ui.clipIndex])); ui.clipIndex += 1; await savePlan(plan); selectClip(ui.clipIndex); });
  async function moveClip(direction, button) { await action(button, async () => { const plan = structuredClone(ui.state.plan); const destination = ui.clipIndex + direction; if (destination < 0 || destination >= plan.clips.length) return; [plan.clips[ui.clipIndex], plan.clips[destination]] = [plan.clips[destination], plan.clips[ui.clipIndex]]; ui.clipIndex = destination; await savePlan(plan); selectClip(ui.clipIndex); }); }
  $('move-clip-before').onclick = () => moveClip(-1, $('move-clip-before'));
  $('move-clip-after').onclick = () => moveClip(1, $('move-clip-after'));
  $('output-preset').onchange = () => action(null, async () => { const plan = structuredClone(ui.state.plan); const presets = { landscape: [1920, 1080, 'flat'], portrait: [1080, 1920, 'flat'], portrait34: [1080, 1440, 'flat'], square: [1080, 1080, 'flat'], '360': [3840, 1920, 'equirectangular'] }; const [width, height, projection] = presets[$('output-preset').value]; plan.output = { ...plan.output, width, height, projection }; try { await savePlan(plan); if (ui.view === 'frame') renderPreview(); } catch (error) { renderPlan(); throw error; } });
  $('output-fps').onchange = () => action(null, async () => { const plan = structuredClone(ui.state.plan); plan.output.fps = Number($('output-fps').value); try { await savePlan(plan); } catch (error) { renderPlan(); throw error; } });
  $('export').onclick = () => action($('export'), async () => { await post('/api/export', { plan: ui.state.plan }); await refresh(); notice('Exportación iniciada. El vídeo estará disponible en Actividad.'); });
  $('jobs').onclick = event => { const button = event.target.closest('[data-cancel]'); if (button) action(button, async () => { await post(`/api/jobs/${encodeURIComponent(button.dataset.cancel)}/cancel`, {}); await refresh(); }); };
  $('save-project').onclick = () => action($('save-project'), async () => { const data = await api('/api/project'); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'orbit360-project.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });

  renderAssets(); renderPlan(); renderPreview(); renderJobs();
  refresh(); setInterval(refresh, 1800);
})();
