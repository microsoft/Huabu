import type {
  DeviceModePreference,
  EffectiveDeviceMode,
  EffectiveTouchInteractionMode,
} from '@/store/toolStore';
import type { ReactFlowInstance } from '@xyflow/react';

/**
 * Live context supplied to every canvas pointer recognizer on each event.
 *
 * Read fresh from refs by the router at dispatch time so a recognizer
 * always sees the current React Flow instance, device modes, and callbacks
 * even if the owning gesture started several renders ago.
 */
export interface CanvasPointerRouterContext {
  wrapper: HTMLDivElement;
  instance: ReactFlowInstance;
  deviceMode: EffectiveDeviceMode;
  deviceModePreference: DeviceModePreference;
  touchInteractionMode: EffectiveTouchInteractionMode;
  explicitToolActive: boolean;
  onTouchTakeover: () => void;
  onEmptyCanvasTap: () => void;
}
