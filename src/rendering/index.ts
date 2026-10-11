/**
 * Renderer entry point: WebGL2 scene when available, otherwise the Canvas2D
 * diagnostic fallback.
 */
import type { Renderer, RenderSource } from './types';
import { SceneManager } from './SceneManager';
import { Fallback2D } from './fallback2d';

export type { Renderer, RenderSource, ViewKind, Overlays } from './types';
export { SceneManager } from './SceneManager';
export { Fallback2D } from './fallback2d';

export function createRenderer(container: HTMLElement, source: RenderSource): Renderer {
  if (SceneManager.supported()) {
    try {
      return new SceneManager(container, source);
    } catch (e) {
      console.warn('[renderer] WebGL2 initialisation failed; using the 2D diagnostic view.', e);
    }
  }
  return new Fallback2D(container, source);
}
