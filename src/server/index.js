import 'source-map-support/register';
import { Server } from '@soundworks/core/server';
import path from 'path';
import serveStatic from 'serve-static';
import compile from 'template-literal';

import PlayerExperience from './PlayerExperience.js';
import ControllerExperience from './ControllerExperience.js';

// import osc from 'osc';

import { Client as OscClient, Server as OscServer } from 'node-osc';

import globalsSchema from './schemas/globals';

import getConfig from './utils/getConfig.js';
const ENV = process.env.ENV || 'default';
const config = getConfig(ENV);
const server = new Server();

// html template and static files (in most case, this should not be modified)
server.templateEngine = { compile };
server.templateDirectory = path.join('.build', 'server', 'tmpl');
server.router.use(serveStatic('public'));
server.router.use('build', serveStatic(path.join('.build', 'public')));
server.router.use('vendors', serveStatic(path.join('.vendors', 'public')));

console.log(`
--------------------------------------------------------
- launching "${config.app.name}" in "${ENV}" environment
- [pid: ${process.pid}]
--------------------------------------------------------
`);

// -------------------------------------------------------------------
// register plugins
// -------------------------------------------------------------------
// server.pluginManager.register(pluginName, pluginFactory, [pluginOptions], [dependencies])

// -------------------------------------------------------------------
// register schemas
// -------------------------------------------------------------------
server.stateManager.registerSchema('globals', globalsSchema);


(async function launch() {
  try {
    // @todo - check how this behaves with a node client...
    await server.init(config, (clientType, config, httpRequest) => {
      return {
        clientType: clientType,
        app: {
          name: config.app.name,
          author: config.app.author,
        },
        env: {
          type: config.env.type,
          websockets: config.env.websockets,
          assetsDomain: config.env.assetsDomain,
        }
      };
    });

    const playerExperience = new PlayerExperience(server, 'player');
    const controllerExperience = new ControllerExperience(server, 'controller');

    const globals = await server.stateManager.create('globals');

    // start all the things
    await server.start();
    playerExperience.start();
    controllerExperience.start();

    const oscConfig = {
      localAddress: '0.0.0.0', // could be 0.0.0.0 by default
      localPort: 57121,
      remoteAddress: '127.0.0.1',
      remotePort: 57122,
    };

    function coerseValue(key, value, def) {
      if (!def) {
        throw new Error(`Param "${key}" does not exists`);
      }

      switch (def.type) {
        case 'float': {
          const coersed = parseFloat(value);

          if (!Number.isNaN(coersed)) {
            return coersed;
          } else {
            if (def.nullable === true) {
              return null;
            } else {
              throw new Error(`Invalid value "${value}" for param "${key}"`);
            }
          }
          break;
        }
        case 'integer': {
          const coersed = parseInt(value);

          if (!Number.isNaN(coersed)) {
            return coersed;
          } else {
            if (def.nullable === true) {
              return null;
            } else {
              throw new Error(`Invalid value "${value}" for param "${key}"`);
            }
          }
          break;
        }
        case 'boolean': {
          return !!value;
          break;
        }
        case 'string': {
          return value + '';
          break;
        }
        case 'enum': {
          const list = def.list;

          if (list.indexOf(value) !== -1) {
            return list;
          } else {
            if (def.nullable === true) {
              return null;
            } else {
              throw new Error(`Invalid value "${value}" for param "${key}"`);
            }
          }
          break;
        }
        case 'any': {
          return value;
          break;
        }
        default: {
          return value;
          break;
        }
      }

      // return value;
    }

    class OscStateManager {
      constructor(config, stateManager) {
        this.config = config;
        this.stateManager = stateManager;

        // we keep a record of attached states, to send a notification to max
        // when the server exists
        this._attachedStates = new Set();
        this._listeners = new Map();
      }

      async init() {
        return new Promise((resolve, reject) => {
          this._oscClient = new OscClient(oscConfig.remoteAddress, oscConfig.remotePort);

          this._oscServer = new OscServer(oscConfig.localPort, oscConfig.localAddress, () => {
            // console.log('osc server inited');
            resolve();
          });

          // listen for incomming messages and dispatch
          this._oscServer.on('message', msg => {
            const [channel, ...args] = msg;
            this._emit(channel, args);
          });

          // send detach messages to max when the server shuts down
          const cleanup = () => {
            console.log('> cleanup...');
            this._attachedStates.forEach(state => {
              const { id, remoteId } = state;
              const channel = `/sw/state-manager/detach-notification/${id}/${remoteId}`;

              // console.log(`[stateId: ${id} - remoteId: ${remoteId}] send detach notification ${channel}`);
              this._oscClient.send(channel);
            });

            setTimeout(() => {
              console.log('> exiting...');
              process.exit();
            }, 1);
          };

          process.once('SIGINT', cleanup);
          process.once('beforeExit', cleanup);

          // subscribe for `attach-request`s
          this._subscribe('/sw/state-manager/attach-request', async (schemaName, stateId) => {
            let state;

            try {
              state = await this.stateManager.attach(schemaName, stateId);
            } catch(err) {
              this._oscClient.send('/sw/state-manager/attach-error', err);
              return;
            }

            this._attachedStates.add(state);

            const { id, remoteId } = state;
            const schema = state.getSchema();

            const updateChannel = `/sw/state-manager/update-request/${id}/${remoteId}`;
            const unsubscribeUpdate = this._subscribe(updateChannel, async updates => {
              updates = JSON.parse(updates);

              for (let key in updates) {
                try {
                  updates[key] = coerseValue(key, updates[key], schema[key])
                } catch(err) {
                  console.log('Ignoring param update:', err.message);
                  delete updates[key];
                }
              }

              // console.log(`[stateId: ${id} - remoteId: ${remoteId}] received updated request ${updateChannel}`, updates);
              await state.set(updates);
            });

            const detachChannel = `/sw/state-manager/detach-request/${id}/${remoteId}`;
            const unsubscribeDetach = this._subscribe(detachChannel, async () => {
              // console.log(`[stateId: ${id} - remoteId: ${remoteId}] detach request ${detachChannel}`);
              unsubscribeUpdate();
              unsubscribeDetach();
              await state.detach();
              // @note - let's if we can do something here to handle
              // update-notifications vs. update-response
            });


            state.subscribe(updates => {
              const channel = `/sw/state-manager/update-notification/${id}/${remoteId}`;
              // console.log(`[stateId: ${id} - remoteId: ${remoteId}] sending update notification ${channel}`, updates);

              updates = JSON.stringify(updates);
              this._oscClient.send(channel, updates);
            });

            // init state listeners

            const schemaStr = JSON.stringify(schema);
            const currentValues = JSON.stringify(state.getValues());

            console.log(`[stateId: ${id} - remoteId: ${remoteId}] sending attach response`);
            this._oscClient.send('/sw/state-manager/attach-response', id, remoteId, schemaName, schemaStr, currentValues);
          });
        });
      }

      _subscribe(channel, callback) {
        if (!this._listeners.has(channel)) {
          this._listeners.set(channel, new Set());
        }

        const listeners = this._listeners.get(channel);
        listeners.add(callback);

        return () => listeners.add(callback);
      }

      _emit(channel, args) {
        if (this._listeners.has(channel)) {
          const listeners = this._listeners.get(channel);
          listeners.forEach(callback => callback(...args));
        }
      }
    }

    const oscStateManager = new OscStateManager(oscConfig, server.stateManager);
    await oscStateManager.init();

  } catch (err) {
    console.error(err.stack);
  }
})();

process.on('unhandledRejection', (reason, p) => {
  console.log(reason);
});
