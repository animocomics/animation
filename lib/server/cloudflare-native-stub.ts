// Native Node renderers are never loaded in the Workers build. The cloud branch
// uses D1/KV and PDFium WASM instead; keeping this stub explicit prevents .node
// addons from being traced into the OpenNext bundle.
const unavailable = () => {
  throw new Error("این ماژول بومی فقط در اجرای محلی Node در دسترس است.");
};

export default unavailable;
export const createCanvas = unavailable;
export const getDocument = unavailable;
export const DOMMatrix = undefined;
export const ImageData = undefined;
export const Path2D = undefined;
