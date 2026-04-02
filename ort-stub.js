// Stub for bare onnxruntime imports that can't resolve in extension context.
// The actual ONNX Runtime is loaded by transformers.js internally via its bundled code.
// This stub provides the named exports that static import statements reference.
export class Tensor {}
export default {};
