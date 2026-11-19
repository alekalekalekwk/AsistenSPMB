// ui-audit.js: pemeriksaan UI otomatis untuk halaman AsistenSPMB.
// Dijalankan DI HALAMAN lewat javascript_tool (bukan di Node). Isi file ini dikirim apa adanya,
// dan nilai terakhirnya (objek hasil) dikembalikan ke Claude.
// Ikut memeriksa isi Shadow DOM yang terbuka, misalnya widget AsistenSPMB.
(() => {
  const LIMIT = 25;
  const viewportWidth = document.documentElement.clientWidth;

  // Semua elemen, termasuk yang ada di dalam shadow root terbuka.
  const all = [];
  (function walk(root) {
    for (const node of root.querySelectorAll('*')) {
      all.push(node);
      if (node.shadowRoot) walk(node.shadowRoot);
    }
  })(document);

  const parentOf = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);

  const describe = (el) => {
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
    const text = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const shadow = el.getRootNode() instanceof ShadowRoot ? ' [widget/shadow]' : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes ? `.${classes}` : ''}${text ? ` "${text}"` : ''}${shadow}`;
  };

  const isVisible = (el) => {
    // checkVisibility() juga menganggap tersembunyi isi <details> yang tertutup dan elemen di dalam display:none.
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false; // termasuk sr-only (1x1 piksel)
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };

  /* Kontras. Warna dibaca lewat canvas, jadi format oklch dari Tailwind v4 dan warna transparan ikut tertangani. */

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const alphaOf = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data[3] / 255;
  };

  // Tumpuk warna dari bawah ke atas, lalu baca hasil akhirnya sebagai [r, g, b].
  const paint = (layers) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const color of layers) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
    }
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };

  const backgroundOf = (el) => {
    const layers = [];
    let hasImage = false;
    for (let node = el; node; node = parentOf(node)) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== 'none') hasImage = true;
      const alpha = alphaOf(style.backgroundColor);
      if (alpha > 0) {
        layers.unshift(style.backgroundColor);
        if (alpha >= 1) break;
      }
    }
    layers.unshift('#ffffff');
    return { layers, hasImage };
  };

  const luminance = (rgb) => rgb
    .map((value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);

  const ratioOf = (a, b) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  };

  const contrastFails = [];
  let textElements = 0;
  for (const el of all) {
    const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    const placeholder = el.matches('input[placeholder], textarea[placeholder]') && !el.value;
    if ((!ownText && !placeholder) || !isVisible(el) || el.closest('svg')) continue;
    if (el.closest(':disabled')) continue; // kontrol nonaktif dikecualikan WCAG
    textElements++;

    const style = getComputedStyle(el);
    const color = placeholder && !ownText ? getComputedStyle(el, '::placeholder').color : style.color;
    const { layers, hasImage } = backgroundOf(el);
    const ratio = ratioOf(paint([...layers, color]), paint(layers));
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (Number(style.fontWeight) >= 700 && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      contrastFails.push({
        el: describe(el) + (placeholder && !ownText ? ' (placeholder)' : ''),
        ratio: Number(ratio.toFixed(2)),
        need,
        fontSize: `${size}px`,
        note: hasImage ? 'ada background-image/gradien, cek manual dengan screenshot' : undefined,
      });
    }
  }

  /* Scroll ke samping: elemen yang melewati lebar layar dan tidak dipotong induknya. */

  const overflow = { scrollWidth: document.documentElement.scrollWidth, clientWidth: viewportWidth, culprits: [] };
  if (overflow.scrollWidth > viewportWidth) {
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.right <= viewportWidth + 1 || !isVisible(el)) continue;
      let clipped = false;
      for (let node = parentOf(el); node && node !== document.documentElement; node = parentOf(node)) {
        if (getComputedStyle(node).overflowX !== 'visible') {
          clipped = true;
          break;
        }
      }
      if (!clipped) overflow.culprits.push(`${describe(el)} → kanan ${Math.round(rect.right)}px`);
    }
  }

  /* Elemen anak yang meluber ke bawah keluar kotak induknya, misalnya teks logo yang patah jadi
     beberapa baris di header h-16. Huruf yang sedikit "nyembul" karena line-height rapat tidak dihitung,
     karena yang dibandingkan kotak elemen anak, bukan bentuk hurufnya. */

  const verticalSpills = [];
  for (const el of all) {
    if (el === document.documentElement || el === document.body || !isVisible(el)) continue;
    const style = getComputedStyle(el);
    if (style.overflowY !== 'visible' || style.display === 'inline' || el.matches('svg, svg *')) continue;
    const bottom = el.getBoundingClientRect().bottom;
    let worst = 0;
    for (const child of el.children) {
      const childStyle = getComputedStyle(child);
      if (!isVisible(child) || childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
      worst = Math.max(worst, child.getBoundingClientRect().bottom - bottom);
    }
    if (worst > 2) verticalSpills.push(`${describe(el)} → isinya keluar ${Math.round(worst)}px ke bawah`);
  }

  /* Kontrol interaktif: ukuran target sentuh, nama yang bisa dibaca pembaca layar, ukuran huruf input. */

  const interactive = all.filter((el) =>
    el.matches('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"]') && isVisible(el));

  // WCAG 2.5.8: target di bawah 24px masih boleh kalau "lingkaran" 24px di tengahnya tidak menabrak target lain.
  const hasSpacing = (el, rect) => {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const box = { left: cx - 12, right: cx + 12, top: cy - 12, bottom: cy + 12 };
    return !interactive.some((other) => {
      if (other === el || other.contains(el) || el.contains(other)) return false;
      const r = other.getBoundingClientRect();
      return r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    });
  };

  const smallTargets = [];
  const unnamedControls = [];
  const smallInputFonts = [];
  for (const el of interactive) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const isInlineLink = el.tagName === 'A' && style.display === 'inline'; // tautan di dalam kalimat dikecualikan

    if (!isInlineLink && (rect.height < 44 || rect.width < 24)) {
      const tiny = rect.height < 24 || rect.width < 24;
      let level = 'kecil (<44px)';
      if (tiny) level = hasSpacing(el, rect) ? 'kecil (<24px, tapi jaraknya cukup)' : 'gagal (<24px dan terlalu rapat)';
      smallTargets.push({ el: describe(el), size: `${Math.round(rect.width)}x${Math.round(rect.height)}`, level });
    }

    if (el.matches('input, textarea, select')) {
      const root = el.getRootNode();
      const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label')
        || (el.id && root.querySelector(`label[for="${CSS.escape(el.id)}"]`))
        || ['submit', 'button', 'reset'].includes(el.type);
      if (!labelled) unnamedControls.push(describe(el));
      const isTextField = !['checkbox', 'radio', 'file', 'range', 'color', 'submit', 'button', 'reset'].includes(el.type);
      if (isTextField && parseFloat(style.fontSize) < 16) smallInputFonts.push(`${describe(el)} → ${style.fontSize}`);
    } else {
      const name = (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.innerText || '').trim();
      if (!name) unnamedControls.push(describe(el));
    }
  }

  const imagesWithoutAlt = all.filter((el) => el.tagName === 'IMG' && !el.hasAttribute('alt')).map(describe);
  const blankWithoutNoopener = all
    .filter((el) => el.matches('a[target="_blank"]') && !/noopener|noreferrer/.test(el.rel))
    .map(describe);

  /* Heading: satu h1, urutan tidak loncat. */

  const headings = all.filter((el) => /^H[1-6]$/.test(el.tagName) && isVisible(el)).map((el) => Number(el.tagName[1]));
  const headingIssues = [];
  const h1Count = headings.filter((level) => level === 1).length;
  if (h1Count !== 1) headingIssues.push(`jumlah h1 = ${h1Count} (seharusnya 1)`);
  headings.forEach((level, i) => {
    if (i > 0 && level > headings[i - 1] + 1) headingIssues.push(`loncat dari h${headings[i - 1]} ke h${level}`);
  });

  smallTargets.sort((a, b) => (a.level === b.level ? 0 : a.level.startsWith('gagal') ? -1 : 1));
  contrastFails.sort((a, b) => a.ratio - b.ratio);

  return {
    page: location.pathname,
    viewport: `${innerWidth}x${innerHeight}`,
    horizontalScroll: overflow.scrollWidth > viewportWidth
      ? { ...overflow, culprits: overflow.culprits.slice(0, LIMIT) }
      : 'tidak ada',
    verticalSpills: verticalSpills.slice(0, LIMIT),
    contrastFails: contrastFails.slice(0, LIMIT),
    contrastFailCount: contrastFails.length,
    smallTargets: smallTargets.slice(0, LIMIT),
    smallTargetCount: smallTargets.length,
    smallInputFonts,
    unnamedControls,
    imagesWithoutAlt,
    blankWithoutNoopener,
    headings: headings.map((level) => `h${level}`).join(' '),
    headingIssues,
    checked: { elements: all.length, textElements, interactive: interactive.length },
  };
})();
