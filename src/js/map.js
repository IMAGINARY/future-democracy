const ServerSocketConnector = require('./lib/net/server-socket-connector');
const ConnectionStateView = require('./lib/net/connection-state-view');
const showFatalError = require('./lib/helpers-web/show-fatal-error');
require('../sass/default.scss');
const fetchConfig = require('./lib/helpers-client/fetch-config');
const fetchTextures = require('./lib/helpers-client/fetch-textures');
const { getApiServerUrl, getSocketServerUrl } = require('./lib/net/server-url');
const { initSentry } = require('./lib/helpers/sentry');
const MapApp = require('./lib/app/map-app');
const { configureLogger } = require('./lib/helpers/configure-logger');

(async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const statsPanel = urlParams.get('s') || null;
  const configUrl = `${getApiServerUrl()}config`;
  const logLevel = urlParams.get('log') || 'warn';
  const logger = configureLogger({ level: logLevel });

  try {
    const sentryDSN = urlParams.get('sentry-dsn') || process.env.SENTRY_DSN;
    let sentryInitialized = false;
    if (sentryDSN) {
      initSentry(sentryDSN);
      sentryInitialized = true;
    }

    const config = await fetchConfig(configUrl);
    if (!sentryInitialized && config?.system?.sentry?.dsn) {
      initSentry(config.system.sentry.dsn);
      sentryInitialized = true;
    }
    const textures = await fetchTextures('./static/textures', config.textures, 'town-view');

    const mapApp = new MapApp(config, textures);
    let round = 0;

    $('[data-component="MapApp"]').replaceWith(mapApp.$element);
    mapApp.resize();
    $(window).on('resize', () => {
      mapApp.resize();
    });

    let syncReceived = false;
    const connector = new ServerSocketConnector(config, getSocketServerUrl(), 'map');
    const connStateView = new ConnectionStateView(connector);
    $('body').append(connStateView.$element);

    connector.events.on('connect', () => {
      syncReceived = true;
    });
    connector.events.on('sync', (message) => {
      syncReceived = true;
      mapApp.stats.ping();
      // If a new round started
      if (message.round && message.storyline
        && (round !== message.round || mapApp.storylineId !== message.storyline)) {
        round = message.round;
        mapApp.setStoryline(message.storyline);
      }
      // Move the players
      Object.entries(message.players).forEach(([id, player]) => {
        if (mapApp.pcs[id] === undefined) {
          mapApp.addPc(id);
        }
        if (player.position) {
          mapApp.pcs[id].setPosition(player.position.x, player.position.y);
        }
        if (player.speed) {
          mapApp.pcs[id].setSpeed(player.speed.x, player.speed.y);
        }
      });
      // Remove players that were not included in the sync
      Object.keys(mapApp.pcs).forEach((id) => {
        if (message.players[id] === undefined) {
          mapApp.removePc(id);
        }
      });
      if (message.flags) {
        let flagsChanged = false;
        const setFlags = new Set(Object.keys(message.flags));
        // Clear all the flags from mapApp.flags not present in setFlags
        Object.keys(mapApp.flags.flags).forEach((flag) => {
          if (!setFlags.has(flag) && mapApp.flags.value(flag) !== 0) {
            mapApp.flags.set(flag, 0);
            logger.info(`Clearing flag ${flag}`);
            flagsChanged = true;
          }
        });
        // Add all the flags from message.flags not present in mapApp.flags.flags
        Object.keys(message.flags).forEach((flag) => {
          if (!mapApp.flags.exists(flag)) {
            mapApp.flags.set(flag, message.flags[flag]);
            logger.info(`Adding flag ${flag} with value ${message.flags[flag]}`);
            flagsChanged = true;
          }
        });
        if (flagsChanged) {
          mapApp.updateQuestMarkers();
          mapApp.updateNpcs();
        }
      }
    });
    mapApp.pixiApp.ticker.add(() => {
      if (syncReceived) {
        connector.sync();
        syncReceived = false;
      }
    });

    if (statsPanel) {
      mapApp.stats.showPanel(statsPanel);
    }

    if (window.CQ === undefined) {
      window.CQ = {
        mapApp,
      };
    }
  } catch (err) {
    showFatalError(err.message, err);
    logger.error(err);
  }
})();
