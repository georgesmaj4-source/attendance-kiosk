// Browser-side face helper built on face-api.js (UMD global: `faceapi`).
// Loads models locally from /models (no internet needed) and extracts a
// 128-d descriptor from a video/image element.
const FaceKit = (() => {
  let loaded = false;
  let loadingPromise = null;

  async function load() {
    if (loaded) return;
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      const base = '/models';
      await faceapi.nets.ssdMobilenetv1.loadFromUri(base);
      await faceapi.nets.faceLandmark68Net.loadFromUri(base);
      await faceapi.nets.faceRecognitionNet.loadFromUri(base);
      await faceapi.nets.faceExpressionNet.loadFromUri(base); // for smile-based liveness
      loaded = true;
    })();
    return loadingPromise;
  }

  // Detect a single face and return { descriptor:[128], box, score } or null.
  async function getDescriptor(input) {
    const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45 });
    const res = await faceapi
      .detectSingleFace(input, opts)
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!res) return null;
    const b = res.detection.box;
    return {
      descriptor: Array.from(res.descriptor),
      box: { x: b.x, y: b.y, width: b.width, height: b.height },
      score: res.detection.score,
    };
  }

  // Detect landmarks + expressions in one pass (used by the liveness loop).
  // Returns { landmarks, expressions, box } or null.
  async function detectLive(input) {
    const res = await faceapi
      .detectSingleFace(input, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 }))
      .withFaceLandmarks()
      .withFaceExpressions();
    if (!res) return null;
    const b = res.detection.box;
    return { landmarks: res.landmarks, expressions: res.expressions, box: { x: b.x, y: b.y, width: b.width, height: b.height } };
  }

  // Just detect a box (for the live overlay) — lighter, no descriptor/landmarks.
  async function detectBox(input) {
    const res = await faceapi.detectSingleFace(
      input, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 })
    );
    if (!res) return null;
    const b = res.box;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  // Capture a downscaled JPEG data URL from a video element (un-mirrored).
  function snapshot(video, maxW = 360, quality = 0.8) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, maxW / vw);
    const c = document.createElement('canvas');
    c.width = Math.round(vw * scale);
    c.height = Math.round(vh * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  return { load, getDescriptor, detectLive, detectBox, snapshot, isLoaded: () => loaded };
})();
