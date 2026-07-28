// Browser-side face helper built on face-api.js (UMD global: `faceapi`).
// Loads models locally from /models (no internet needed) and extracts a
// 128-d descriptor from a video/image element.
//
// Uses the lightweight TinyFaceDetector (fast to load + fast per scan) instead of
// the heavy SSD MobileNet — a big win on older iPads. The 128-d descriptor comes
// from the recognition net after landmark alignment, so matching quality is the
// same regardless of which detector found the face.
const FaceKit = (() => {
  let loaded = false;         // detector + landmarks + recognition ready
  let loadingPromise = null;
  let expLoaded = false;      // expression net (only needed for smile liveness)

  // Tuned for a close-range kiosk: small input size = fast; the face is large in frame.
  const detOptions = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.35 });

  async function load({ expressions = false } = {}) {
    if (!loaded) {
      if (!loadingPromise) {
        loadingPromise = (async () => {
          const base = '/models';
          await faceapi.nets.tinyFaceDetector.loadFromUri(base);
          await faceapi.nets.faceLandmark68Net.loadFromUri(base);
          await faceapi.nets.faceRecognitionNet.loadFromUri(base);
          loaded = true;
        })();
      }
      await loadingPromise;
    }
    if (expressions && !expLoaded) {
      await faceapi.nets.faceExpressionNet.loadFromUri('/models');
      expLoaded = true;
    }
  }

  // Detect a single face and return { descriptor:[128], box, score } or null.
  async function getDescriptor(input) {
    const res = await faceapi
      .detectSingleFace(input, detOptions())
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
  async function detectLive(input) {
    const res = await faceapi
      .detectSingleFace(input, detOptions())
      .withFaceLandmarks()
      .withFaceExpressions();
    if (!res) return null;
    const b = res.detection.box;
    return { landmarks: res.landmarks, expressions: res.expressions, box: { x: b.x, y: b.y, width: b.width, height: b.height } };
  }

  // Just detect a box — lightest call (no landmarks/descriptor).
  async function detectBox(input) {
    const res = await faceapi.detectSingleFace(input, detOptions());
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
