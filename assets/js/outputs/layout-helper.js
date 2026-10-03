(function (root) {
  'use strict';

  function getLayoutGeometry(preset, corner) {
    const defaultMedia = { left: 0, top: 0, width: 100, height: 100 };
    const defaultCamera = { left: 0, top: 0, width: 100, height: 100 };

    if (!preset || preset === 'full') {
      return { media: defaultMedia, camera: defaultCamera };
    }

    if (preset === 'split-left') {
      return {
        media: { left: 0, top: 0, width: 50, height: 100 },
        camera: { left: 50, top: 0, width: 50, height: 100 }
      };
    }

    if (preset === 'split-right') {
      return {
        media: { left: 50, top: 0, width: 50, height: 100 },
        camera: { left: 0, top: 0, width: 50, height: 100 }
      };
    }

    if (preset === 'camera-inset') {
      let cameraRect = { left: 68, top: 68, width: 30, height: 30 };
      if (corner === 'top-left') {
        cameraRect = { left: 2, top: 2, width: 30, height: 30 };
      } else if (corner === 'top-right') {
        cameraRect = { left: 68, top: 2, width: 30, height: 30 };
      } else if (corner === 'bottom-left') {
        cameraRect = { left: 2, top: 68, width: 30, height: 30 };
      } else if (corner === 'bottom-right') {
        cameraRect = { left: 68, top: 68, width: 30, height: 30 };
      }
      return {
        media: { left: 0, top: 0, width: 100, height: 100 },
        camera: cameraRect
      };
    }

    return { media: defaultMedia, camera: defaultCamera };
  }

  function getMediaClipPath(preset, corner, cameraActive) {
    if (!cameraActive || !preset || preset === 'full') {
      return '';
    }
    const geom = getLayoutGeometry(preset, corner);
    if (preset === 'split-left') {
      return 'polygon(0% 0%, 50% 0%, 50% 100%, 0% 100%)';
    }
    if (preset === 'split-right') {
      return 'polygon(50% 0%, 100% 0%, 100% 100%, 50% 100%)';
    }
    if (preset === 'camera-inset') {
      const c = geom.camera;
      return `polygon(evenodd, 0% 0%, 0% 100%, 100% 100%, 100% 0%, 0% 0%, ${c.left}% ${c.top}%, ${c.left + c.width}% ${c.top}%, ${c.left + c.width}% ${c.top + c.height}%, ${c.left}% ${c.top + c.height}%, ${c.left}% ${c.top}%)`;
    }
    return '';
  }

  function getCameraClipPath(preset, corner) {
    if (!preset || preset === 'full') {
      return '';
    }
    const geom = getLayoutGeometry(preset, corner);
    const c = geom.camera;
    return `polygon(${c.left}% ${c.top}%, ${c.left + c.width}% ${c.top}%, ${c.left + c.width}% ${c.top + c.height}%, ${c.left}% ${c.top + c.height}%)`;
  }

  root.EmberstageLayoutHelper = {
    getLayoutGeometry,
    getMediaClipPath,
    getCameraClipPath
  };

})(typeof globalThis !== 'undefined' ? globalThis : window);
