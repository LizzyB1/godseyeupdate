import * as Cesium from 'cesium';
import { StyleManager } from './ui.js';
import { flyToPalma } from './camera.js';
import { DataLayerManager } from './data/manager.js';
import flightsLayer from './data/flights.js';
import militaryFlightsLayer from './data/militaryFlights.js';
import earthquakesLayer from './data/earthquakes.js';
import satellitesLayer from './data/satellites.js';
import rocketLaunchesLayer from './data/rocketLaunches.js';
import trafficLayer from './data/traffic.js';
import cctvLayer from './data/cctv.js';
import radioLayer from './data/radio.js';
import bikeshareLayer from './data/bikeshare.js';
import aisLiveVesselsLayer from './data/aisLiveVessels.js';
import militaryInstallationsLayer from './data/militaryInstallations.js';
import militaryAwarenessLayer from './data/militaryAwareness.js';
import localDataLayers from './data/localLayers.js';
import { LAYER_STATE_REGISTRY, LAYER_STATE_STORAGE_KEY } from './data/layerState.js';
import { registerDataCredits } from './data/dataCredits.js';
import { SceneDirector } from './scenes/director.js';
import { initGevVoiceCommands } from './voice/gevRealtime.js';
import { MapStackController } from './mapStackController.js';
import { initAnnotations } from './annotations/index.js';
import { initLogoGaze } from './logoGaze.js';
import { initCockpitCloudEffects } from './cockpitCloudEffects.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from './renderGovernor.js';
import { initCameraControls } from './cameraControls.js';
import { initGpsTrackOverlay } from './data/gpsTracks.js';
import { initGpsTrackPanel } from './gpsTrackPanel.js';
import { initPanelDragging } from './panelDrag.js';
import { initMapOverlays } from './data/mapOverlays.js';
import { initMapOverlayControls } from './mapOverlayControls.js';
import { initCoordinatesBox } from './coordinatesBox.js';
import { resolveApiKey } from './apiKeys.js';
import { initSettingsDialog, OPACITY_STORAGE_KEY } from './settingsDialog.js';
import { fetchSessionSettings, createSessionSettingsAutosave } from './sessionSettingsClient.js';

initLogoGaze();
// Independent of the Cesium bootstrap below (and its try/catch): a missing
// GOOGLE_MAPS_API_KEY throws before the viewer ever exists, and this is the
// one recovery path for that case — a person can open Settings and add a
// key without editing .env on disk. See src/settingsDialog.js.
window.__godsEyeView = { ...(window.__godsEyeView || {}), settingsDialog: initSettingsDialog() };

// Kick off the transportable-session-settings fetch as early as possible
// (see src/data/sessionSettings.js, src/sessionSettingsClient.js) so it
// resolves in parallel with the Cesium/Google-3D-Tiles bootstrap below
// instead of adding to it — init() awaits this promise, not a fresh fetch.
const sessionSettingsPromise = fetchSessionSettings();

/**
 * Extract a human-readable error message from any thrown value.
 * Handles Error objects, strings, and plain objects with message/error fields.
 * @param {*} error — caught exception value
 * @returns {string} best-effort error description
 */
function describeError(error) {
  if (!error) return 'Unknown initialization error';
  if (error instanceof Error) {
    if (error.message && error.message.trim()) return error.message.trim();
    return error.name || 'Initialization error';
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error === 'object') {
    const maybeMessage = String(error.message || error.error || '').trim();
    if (maybeMessage) return maybeMessage;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // ignore serialization error
    }
  }
  return String(error);
}

/**
 * GOD'S EYE VIEW — Main Entry Point
 * Initializes CesiumJS with Google Photorealistic 3D Tiles,
 * style system, intelligence HUD, location presets, and share links.
 */
async function init() {
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');

  try {
    loaderStatus.textContent = 'Configuring viewer...';

    // Restore transportable session settings (src/data/sessionSettings.js)
    // as early as possible — before the layer-state coordinator or the
    // opacity slider read `localStorage`, so a fresh clone that copied over
    // gev.settings.json (or a dev server with saved state) comes back
    // looking the way it did last session instead of at hardcoded defaults.
    // Never throws (fetchSessionSettings swallows its own errors) and never
    // blocks longer than its own internal timeout, so a clone with no
    // saved file, or no dev server at all, boots exactly as before.
    const sessionSettings = await sessionSettingsPromise;
    if (sessionSettings?.layerState) {
      try { localStorage.setItem(LAYER_STATE_STORAGE_KEY, sessionSettings.layerState); } catch { /* storage unavailable */ }
    }
    if (sessionSettings?.panelAlpha != null) {
      window.__godsEyeView?.settingsDialog?.applyPanelAlpha?.(sessionSettings.panelAlpha);
    }

    // Set Cesium Ion token for World Terrain — a browser-saved override
    // (settings dialog) takes priority over the build-time .env value; see
    // src/apiKeys.js for why editing .env directly isn't possible here.
    const cesiumToken = resolveApiKey('CESIUM_ION_TOKEN', import.meta.env.CESIUM_ION_TOKEN);
    if (cesiumToken) {
      Cesium.Ion.defaultAccessToken = cesiumToken;
    }

    // Set Google Maps API key for 3D Tiles
    const googleApiKey = resolveApiKey('GOOGLE_MAPS_API_KEY', import.meta.env.GOOGLE_MAPS_API_KEY);
    if (!googleApiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY not found. Set it as an environment variable, or add it in Settings (gear icon).');
    }
    Cesium.GoogleMaps.defaultApiKey = googleApiKey;

    // Expose API key globally for geocoding in locations.js
    window.__GOOGLE_MAPS_API_KEY__ = googleApiKey;

    // Create the Cesium viewer with minimal chrome
    const viewer = new Cesium.Viewer('cesiumContainer', {
      timeline: false,
      animation: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      vrButton: false,
      selectionIndicator: false,
      infoBox: false,
      baseLayer: false,
      // Visible attribution container — Google Maps / 3D Tiles credits are
      // required by Google's Terms of Service, so they must be shown (styled
      // subtly via #cesium-credits). The credit line stays visible in
      // clean-view AND recording modes too (ToS requires attribution while the
      // content is displayed — those are the exact modes used to record
      // demos), including the "Data attribution" link that opens the per-layer
      // license popover.
      creditContainer: (() => {
        const el = document.createElement('div');
        el.id = 'cesium-credits';
        document.body.appendChild(el);
        return el;
      })(),
      msaaSamples: 4,
      contextOptions: {
        webgl: {
          preserveDrawingBuffer: true,
        },
      },
    });

    // Cap the default render loop at 60 fps. Cesium's loop otherwise runs at
    // the display's refresh rate — 120 Hz on ProMotion panels — doubling GPU
    // and CPU burn for zero visual benefit in a map app whose animation
    // cadences (poll interpolation, trail fades, style crossfades) are all
    // designed against wall-clock time, not frame count. Measured on the
    // 2026-08-05 perf investigation as a strict halving of idle burn on
    // 120 Hz hardware; a no-op on 60 Hz displays. (perf item 2)
    viewer.targetFrameRate = 60;

    // Register per-layer data attribution into the "Data attribution" popover.
    // Required by each source's license (ODbL, CC BY-NC-SA, NASA FIRMS, etc.);
    // strings are verbatim from DATA_SOURCES.md. Static + always-present in the
    // expandable bottom-left credit lightbox (showOnScreen=false), so they never
    // clutter the on-globe attribution line.
    registerDataCredits(viewer);

    // Hide Cesium's default globe — Google Photorealistic 3D Tiles provide their own
    // globe at all LODs (street level → orbital). The default globe's 2D imagery
    // clips through 3D tile buildings at close range.
    viewer.scene.globe.show = false;

    // Keep a sky behind Google 3D Tiles, but soften Cesium's high-intensity
    // default atmosphere. With the globe hidden its bright limb otherwise
    // reads as a hard cyan seam where distant photoreal tiles meet the sky.
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
    viewer.scene.skyAtmosphere.saturationShift = -0.12;
    viewer.scene.skyAtmosphere.brightnessShift = -0.08;

    loaderStatus.textContent = 'Loading Google 3D Tiles...';
    let tileset = null;
    try {
      // Load Google Photorealistic 3D Tiles
      tileset = await Cesium.createGooglePhotorealistic3DTileset({
        onlyUsingWithGoogleGeocoder: true,
      });
      viewer.scene.primitives.add(tileset);
      // NOTE: Cesium World Terrain intentionally disabled — conflicts with Google 3D Tiles at high zoom.
      // Google Photorealistic 3D Tiles provide their own terrain/elevation.
      viewer.scene.globe.show = false;
    } catch (tileError) {
      console.warn('[Init] Google 3D Tiles unavailable, falling back to Cesium globe:', tileError);
      const tileErrorDetail = describeError(tileError);
      loaderStatus.textContent = `Google 3D Tiles unavailable (${tileErrorDetail}). Continuing in fallback mode...`;
      // Keep Cesium globe visible as fallback instead of aborting the app.
      viewer.scene.globe.show = true;
    }

    loaderStatus.textContent = 'Initializing systems...';

    // A saved session's map stack wins over the hardcoded default — but a
    // share-link (checked below via `styleManager.hasShareState`) still wins
    // over THIS, exactly as it already does for the layer state seeded
    // above: `_setMapStack()` runs during share restore and unconditionally
    // overwrites whatever stack this boot call lands on, so applying the
    // saved stack here first is safe even when a share link is present.
    const restoredMapStack = sessionSettings?.mapStack;
    const bootStack = restoredMapStack || (tileset ? 'photoreal' : 'osm');
    const mapStackController = new MapStackController(viewer, {
      googleTileset: tileset,
      cesiumToken,
      initialStack: bootStack,
      // Task 5 (height-datum fix): rebroadcast stack changes as a window
      // CustomEvent so data layers (CCTV per-regime ground resolution) can
      // react without coupling MapStackController to layer modules. Fires on
      // 'switching'/'ready'/'error'; listeners derive the surface regime from
      // live scene state, so intermediate emissions are harmless.
      onChange: (state) => {
        window.dispatchEvent(new CustomEvent('gev:map-stack-changed', { detail: state }));
      },
      onError: (message) => console.warn('[MapStack]', message),
    });
    await mapStackController.setStack(bootStack, { silent: true });

    // Initialize the style manager (post-processing, HUD, locations, share links)
    const styleManager = new StyleManager(viewer, { mapStackController });
    // The previous multi-canvas weather compositor remains disabled. Cockpit
    // clouds use a separate, capped low-resolution GPU pass that never attaches
    // Cesium fog or post-process stages and is fully stopped in map mode.
    const weatherEffects = null;
    const cockpitCloudEffects = initCockpitCloudEffects(viewer);

    // A share link always wins (it's an explicit, just-clicked intent). Next,
    // a saved session camera pose — set directly with no flight animation,
    // since this is a restore of where the operator already was, not a
    // scripted arrival. Otherwise fall back to the default cinematic
    // fly-to-Palma used on a genuinely fresh clone/browser.
    const restoredCamera = sessionSettings?.camera;
    if (styleManager.hasShareState) {
      loaderStatus.textContent = 'Restoring shared view...';
    } else if (restoredCamera) {
      loaderStatus.textContent = 'Restoring last session...';
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(restoredCamera.lon, restoredCamera.lat, restoredCamera.height),
        orientation: {
          heading: restoredCamera.heading,
          pitch: restoredCamera.pitch,
          roll: restoredCamera.roll,
        },
      });
    } else {
      loaderStatus.textContent = 'Flying to Palma, Spain...';
      flyToPalma(viewer);
    }

    // Initialize data layer manager
    const dataManager = new DataLayerManager(viewer, {
      allowQaRegistration: import.meta.env.DEV,
    });
    dataManager.register(flightsLayer);
    dataManager.register(militaryFlightsLayer);
    dataManager.register(earthquakesLayer);
    dataManager.register(satellitesLayer);
    dataManager.register(rocketLaunchesLayer);
    rocketLaunchesLayer.attachDataManager(dataManager);
    dataManager.register(trafficLayer);
    dataManager.register(cctvLayer);
    dataManager.register(radioLayer);
    dataManager.register(bikeshareLayer);
    dataManager.register(aisLiveVesselsLayer);
    dataManager.register(militaryInstallationsLayer);
    dataManager.register(militaryAwarenessLayer);
    militaryAwarenessLayer.attachDataManager(dataManager);
    for (const layer of localDataLayers) {
      dataManager.register(layer);
    }
    // Restoration starts only after the complete production registry is sealed.
    dataManager.finalizeRegistrations(LAYER_STATE_REGISTRY);
    if (import.meta.env.DEV) {
      window.__gevQaRegisterLayer = (targetManager, layerModule) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.registerForQa(layerModule);
      };
      window.__gevQaUnregisterLayer = (targetManager, layerId) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.unregisterForQa(layerId);
      };
    }
    dataManager.buildTogglePanel(document.getElementById('data-toggles'));
    styleManager.attachDataManager(dataManager);

    // Initialize deterministic scene playback for social clip capture
    const sceneDirector = new SceneDirector(viewer, styleManager, dataManager);

    // Initialize the voice "whiteboard" annotation engine (world-space renderer)
    const annotations = initAnnotations({ viewer, tileset });

    // Keep startup chrome truthful: a share is not restored until camera,
    // visual/map/panel lanes, and every requested layer have terminated.
    void Promise.all([
      styleManager.initialRestorePromise,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]).finally(() => {
      loadingScreen.classList.add('hidden');
    });

    // The mission launcher no longer auto-shows on load (product change: it
    // now lives as an on-demand "Mission" section inside Settings, so a
    // returning operator isn't interrupted on every fresh session). Wire the
    // dialog's mission buttons up now that styleManager/dataManager exist —
    // dataManager is passed explicitly: the globe missions enable bundled
    // keyless layers through it, and reaching for styleManager._dataManager
    // would make a private field part of this feature's contract.
    window.__godsEyeView?.settingsDialog?.attachMissionRunner?.({ styleManager, dataManager });

    // Expose for debugging
    // Idle render governor: flips the scene into requestRenderMode whenever
    // nothing animates per frame. Installed AFTER every module above has had
    // its chance to register pre-install holds. (perf wave 2)
    installRenderGovernor(viewer);

    // Keyboard (WASD/arrows ground move, T/G pitch, R/F zoom) + on-screen pad
    // camera controls — horizon always locked level, no yaw-in-place or roll
    // — see src/cameraControls.js.
    const cameraControls = initCameraControls(viewer);

    // GPS track module loader: load raw NMEA logger dumps or GPX files
    // (from the gps_manager.py / nmea_to_gpx.py toolkit) client-side and
    // view them as glowing polyline overlays on the globe. Self-contained —
    // see src/data/gpsTracks.js and src/gpsTrackPanel.js — not wired into
    // DataLayerManager/LAYER_STATE_REGISTRY.
    const gpsTrackOverlay = initGpsTrackOverlay(viewer);
    const gpsTrackPanel = initGpsTrackPanel(gpsTrackOverlay);

    // Map overlays: elevation contours, vertical exaggeration, lat/long
    // grid, and the screenshot tool — see src/data/mapOverlays.js (engine)
    // and src/mapOverlayControls.js (box). The coordinate cursor/pin tool
    // is its own separately movable/resizable/hidable box on the same
    // engine — see src/coordinatesBox.js.
    const mapOverlays = initMapOverlays(viewer);
    const mapOverlayControls = initMapOverlayControls(mapOverlays);
    const coordinatesBox = initCoordinatesBox(mapOverlays);

    // GUI overhaul: lets the DISPLAY, DATA LAYERS, CCTV, and SCENES panels be
    // dragged free of their managed stacks — see src/panelDrag.js for why
    // global-context-panel and the command-dock trays are intentionally left
    // out (they lean on rail-scoped CSS this can't safely reproduce).
    const panelDrag = initPanelDragging();

    // The follow camera recomputes the tracked target's dead-reckon position
    // every frame — tracking anything is a per-frame animation. (perf wave 2)
    viewer.trackedEntityChanged.addEventListener(() => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    });

    // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
    // stop the default render loop outright — a hidden canvas repaints for
    // nobody, and browser rAF throttling still lets throttled frames burn
    // GPU. Holder/data state is untouched, so return is seamless: restore
    // the loop, refresh the one DOM surface we gated, render a frame.
    const syncVisibilitySuspension = () => {
      const hidden = document.hidden;
      viewer.useDefaultRenderLoop = !hidden;
      cockpitCloudEffects?.setSuspended?.(hidden);
      if (!hidden) {
        if (dataManager._panelRefreshPendingOnVisible) {
          dataManager._panelRefreshPendingOnVisible = false;
          dataManager._refreshTogglePanel();
        }
        governorRequestRender('visibility-restore');
      }
    };
    document.addEventListener('visibilitychange', syncVisibilitySuspension);
    // Apply the CURRENT state too — bootstrap can complete while the tab is
    // already hidden, and waiting for the next transition would leave the
    // loop burning behind a hidden tab. (perf wave 2 fix)
    syncVisibilitySuspension();

    // Transportable session-settings autosave (src/data/sessionSettings.js,
    // src/sessionSettingsClient.js) — keeps `gev.settings.json` current so
    // the NEXT boot's restore above has something fresh to read. Reads
    // straight from `localStorage`/live viewer/controller state rather than
    // hooking into each individual subsystem's own change events (layer
    // toggles, the transparency slider) — cheap enough to poll, and every
    // one of those already commits to `localStorage` synchronously the
    // moment it changes, so a snapshot never observes a half-applied change.
    const scheduleSessionSave = createSessionSettingsAutosave();
    let lastSessionSnapshotJson = null;
    const captureSessionSnapshot = () => {
      const carto = viewer.camera.positionCartographic;
      const camera = carto ? {
        lon: Cesium.Math.toDegrees(carto.longitude),
        lat: Cesium.Math.toDegrees(carto.latitude),
        height: carto.height,
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: viewer.camera.roll,
      } : null;
      let panelAlpha = null;
      try {
        const stored = localStorage.getItem(OPACITY_STORAGE_KEY);
        const raw = stored === null ? NaN : Number(stored);
        panelAlpha = Number.isFinite(raw) ? raw : null;
      } catch { /* storage unavailable */ }
      let layerState = null;
      try { layerState = localStorage.getItem(LAYER_STATE_STORAGE_KEY) || null; } catch { /* storage unavailable */ }
      return { camera, mapStack: mapStackController.getActiveId(), panelAlpha, layerState };
    };
    const saveSessionIfChanged = () => {
      const snapshot = captureSessionSnapshot();
      const json = JSON.stringify(snapshot);
      if (json === lastSessionSnapshotJson) return;
      lastSessionSnapshotJson = json;
      scheduleSessionSave(snapshot);
    };
    viewer.camera.moveEnd.addEventListener(saveSessionIfChanged);
    window.addEventListener('gev:map-stack-changed', saveSessionIfChanged);
    // Catch-all for state changes without a dedicated event above (layer
    // toggles, the transparency slider) — cheap no-op when nothing changed.
    setInterval(saveSessionIfChanged, 20000);

    window.__godsEyeView = {
      ...window.__godsEyeView,
      viewer,
      styleManager,
      tileset,
      dataManager,
      sceneDirector,
      mapStackController,
      annotations,
      weatherEffects,
      cockpitCloudEffects,
      cameraControls,
      gpsTrackOverlay,
      gpsTrackPanel,
      mapOverlays,
      mapOverlayControls,
      coordinatesBox,
      panelDrag,
      getRenderGovernorDiagnostics,
      requestRender: governorRequestRender,
    };
    window.__godsEyeView.voiceCommands = initGevVoiceCommands({ viewer, styleManager, dataManager, sceneDirector, annotations });

  } catch (error) {
    console.error("God's Eye View initialization failed:", error);
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  }
}

init();
