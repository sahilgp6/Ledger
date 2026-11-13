// Runs the language model off the main thread so the app stays responsive.
import { WebWorkerMLCEngineHandler } from '../vendor/web-llm.js';
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
