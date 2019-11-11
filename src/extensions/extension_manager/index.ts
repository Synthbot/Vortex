import {IExtensionApi, IExtensionContext} from '../../types/IExtensionContext';
import { IExtensionLoadFailure, IState } from '../../types/IState';
import { relaunch } from '../../util/commandLine';
import { log } from '../../util/log';
import makeReactive from '../../util/makeReactive';

import { setAvailableExtensions, setExtensionsUpdate, setInstalledExtensions } from './actions';
import BrowseExtensions from './BrowseExtensions';
import ExtensionManager from './ExtensionManager';
import sessionReducer from './reducers';
import { IAvailableExtension, IExtensionDownloadInfo } from './types';
import { downloadAndInstallExtension, fetchAvailableExtensions, readExtensions } from './util';

import * as Promise from 'bluebird';
import * as _ from 'lodash';

interface ILocalState {
  reloadNecessary: boolean;
}

const localState: ILocalState = makeReactive({
  reloadNecessary: false,
});

function checkForUpdates(api: IExtensionApi) {
  const state: IState = api.store.getState();
  const { available, installed }  = state.session.extensions;

  const updateable: IAvailableExtension[] = Object.values(installed).reduce((prev, ext) => {
    if (ext.modId === undefined) {
      return prev;
    }

    const current = available.find(iter => iter.modId === ext.modId);
    if (current === undefined) {
      return prev;
    }

    if (current.version === ext.version) {
      return prev;
    }

    prev.push(current);

    return prev;
  }, []);

  if (updateable.length === 0) {
    return Promise.resolve();
  }

  api.sendNotification({
    id: 'extension-updates',
    type: 'info',
    message: '{{ count }} extensions will be updated',
    replace: { count: updateable.length },
  });

  log('info', 'extensions can be updated', {
    updateable: updateable.map(ext => `${ext.name} v${ext.version}`) });

  return Promise.map(updateable, ext => downloadAndInstallExtension(api, ext))
    .then(() => {
      localState.reloadNecessary = true;
      api.sendNotification({
        id: 'extension-updates',
        type: 'success',
        message: 'Extensions updated, please restart to apply them',
        actions: [
          {
            title: 'Restart now', action: () => {
              relaunch();
            },
          },
        ],
      });
    });
}

function updateAvailableExtensions(api: IExtensionApi, force: boolean = false) {
  return fetchAvailableExtensions(true, force)
    .catch(err => {
      api.showErrorNotification('Failed to fetch available extensions', err);
      return { time: null, extensions: [] };
    })
    .then(({ time, extensions }: { time: Date, extensions: IAvailableExtension[] }) => {
      api.store.dispatch(setExtensionsUpdate(time.getTime()));
      api.store.dispatch(setAvailableExtensions(extensions));
      return checkForUpdates(api);
    });
}

function installDependency(api: IExtensionApi,
                           extName: string,
                           updateInstalled: (initial: boolean) => Promise<void>): Promise<boolean> {
  const state: IState = api.store.getState();
  const availableExtensions = state.session.extensions.available;
  const ext = availableExtensions.find(iter => iter.name === extName);
  if (ext !== undefined) {
    return downloadAndInstallExtension(api, ext)
      .then(() => updateInstalled(false))
      .then(() => true);
  } else {
    return Promise.resolve(false);
  }
}

function checkMissingDependencies(api: IExtensionApi,
                                  loadFailures: { [extId: string]: IExtensionLoadFailure[] }) {
    const missingDependencies = Object.keys(loadFailures)
      .reduce((prev, extId) => {
        const deps = loadFailures[extId].filter(fail => fail.id === 'dependency');
        deps.forEach(dep => {
          const depId = dep.args.dependencyId;
          if (prev[depId] === undefined) {
            prev[depId] = [];
          }
          prev[depId].push(extId);
        });
        return prev;
      }, {});

    if (Object.keys(missingDependencies).length > 0) {
      const updateInstalled = genUpdateInstalledExtensions(api);
      api.sendNotification({
        type: 'warning',
        message: 'Some of the installed extensions couldn\'t be loaded because '
               + 'they have missing dependencies.',
        actions: [
          { title: 'Fix', action: () => {
            Promise.map(Object.keys(missingDependencies), depId =>
              installDependency(api, depId, updateInstalled)
                .then(results => {
                  if (!results) {
                    api.showErrorNotification('Failed to install extension', 'Not found', {
                      message: depId,
                      allowReport: false,
                    });
                  }
                })
                .catch(err => {
                  api.showErrorNotification('Failed to install extension', err, {
                    message: depId,
                  });
                }));
          } },
        ],
      });
    }
}

function genUpdateInstalledExtensions(api: IExtensionApi) {
  return (initial: boolean): Promise<void> => {
    return readExtensions(true)
      .then(ext => {
        const state: IState = api.store.getState();
        if (!initial && !_.isEqual(state.session.extensions.installed, ext)) {
          localState.reloadNecessary = true;
        }
        api.store.dispatch(setInstalledExtensions(ext));
      })
      .catch(err => {
        // this probably only occurs if the user deletes the plugins directory after start
        api.showErrorNotification('Failed to read extension directory', err, {
          allowReport: false,
        });
      });
  };
}

function init(context: IExtensionContext) {
  const updateExtensions = genUpdateInstalledExtensions(context.api);
  context.registerMainPage('extensions', 'Extensions', ExtensionManager, {
    hotkey: 'X',
    group: 'global',
    visible: () => context.api.store.getState().settings.interface.advanced,
    props: () => ({
      localState,
      updateExtensions,
    }),
  });

  const forceUpdateExtensions = () => {
    updateAvailableExtensions(context.api, true);
  };

  context.registerDialog('browse-extensions', BrowseExtensions, () => ({
    localState,
    updateExtensions,
    onRefreshExtensions: forceUpdateExtensions,
  }));

  context.registerReducer(['session', 'extensions'], sessionReducer);

  context.once(() => {
    updateExtensions(true);
    updateAvailableExtensions(context.api);
    context.api.onAsync('install-extension', (ext: IExtensionDownloadInfo) =>
      downloadAndInstallExtension(context.api, ext)
        .then(() => updateExtensions(false)));

    context.api.onStateChange(['session', 'base', 'extLoadFailures'], (prev, current) => {
      checkMissingDependencies(context.api, current);
    });

    {
      const state: IState = context.api.store.getState();
      checkMissingDependencies(context.api, state.session.base.extLoadFailures);
    }
  });

  return true;
}

export default init;