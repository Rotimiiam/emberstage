(function (root) {
  'use strict';

  const MAX_PDF_PAGES = 80;
  // OBS on this machine disables browser GPU. A 1920px page of a multi-page
  // deck exhausts the software canvas. 1280px still fills a 1080p program.
  const OUTPUT_WIDTH = 960;

  function loadPdfJs() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('assets/vendor/pdfjs/pdf.min.js', window.location.href).href;
      script.onload = () => {
        const lib = root.pdfjsLib;
        if (!lib) {
          reject(new Error('PDF reader did not start.'));
          return;
        }
        lib.GlobalWorkerOptions.workerSrc = new URL('assets/vendor/pdfjs/pdf.worker.min.js', window.location.href).href;
        resolve(lib);
      };
      script.onerror = () => reject(new Error('PDF reader could not be loaded.'));
      document.head.appendChild(script);
    });
  }

  async function renderPage(page, name) {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: OUTPUT_WIDTH / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error(`Could not draw ${name}.`);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    // OBS browser sources often have no canvas.toBlob. JPEG is smaller than
    // PNG, which matters when every page of a deck stays in memory.
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    canvas.width = 1;
    canvas.height = 1;
    const encoded = dataUrl.split(',')[1];
    if (!encoded) throw new Error(`Could not draw ${name}.`);
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'image/jpeg' });
  }

  async function openPdf(file) {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    // Keep embedded fonts. Turning them off draws a blank page when the
    // standard-font files are not installed in the OBS browser.
    return pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  }

  async function renderPdf(file, options = {}) {
    const limit = options.maxPages || MAX_PDF_PAGES;
    const onlyPage = Number.isInteger(options.page) ? options.page : 0;
    const pdf = await openPdf(file);
    try {
      if (pdf.numPages > limit) {
        throw new Error(`This PDF has ${pdf.numPages} pages. A deck can hold ${limit}. Split it and add the rest separately.`);
      }
      const base = String(file.name || 'slides.pdf').replace(/\.pdf$/i, '');
      const numbers = onlyPage > 0 ? [onlyPage] : Array.from({ length: pdf.numPages }, (_, index) => index + 1);
      const slides = [];
      for (const number of numbers) {
        if (number < 1 || number > pdf.numPages) throw new Error(`This PDF has no page ${number}.`);
        const page = await pdf.getPage(number);
        slides.push({
          name: `${base} ${number}`,
          page: number,
          pageCount: pdf.numPages,
          file: await renderPage(page, `${base}-${number}`)
        });
        page.cleanup();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return slides;
    } finally {
      await pdf.destroy();
    }
  }

  root.EmberstagePdfSlides = { MAX_PDF_PAGES, renderPdf };
})(typeof globalThis !== 'undefined' ? globalThis : window);
