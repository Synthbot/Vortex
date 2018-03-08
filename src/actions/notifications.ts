import { DialogActions, DialogType, IDialogContent, IDialogResult } from '../types/IDialog';
import { INotification, NotificationDismiss } from '../types/INotification';
import local from '../util/local';
import {log} from '../util/log';
import {truthy} from '../util/util';

import safeCreateAction from './safeCreateAction';

import * as Promise from 'bluebird';
import { ipcMain, ipcRenderer } from 'electron';
import * as reduxAct from 'redux-act';

import { generate as shortid } from 'shortid';

export * from '../types/IDialog';

const identity = input => input;

/**
 * adds a notification to be displayed. Takes one parameter of type INotification. The id may be
 * left unset, in that case one will be generated
 */
export const startNotification = safeCreateAction('ADD_NOTIFICATION', identity);

/**
 * dismiss a notification. Takes the id of the notification
 */
export const stopNotification = safeCreateAction('STOP_NOTIFICATION', identity);

/**
 * show a modal dialog to the user
 *
 * don't call this directly, use showDialog
 */
export const addDialog = safeCreateAction(
    'SHOW_MODAL_DIALOG',
    (id: string, type: string, title: string, content: IDialogContent,
     defaultAction: string, actions: string[]) =>
        ({id, type, title, content, defaultAction, actions}));

/**
 * dismiss the dialog being displayed
 *
 * don't call this directly especially when you used "showDialog" to create the dialog or
 * you leak (a tiny amount of) memory and the action callbacks aren't called.
 * Use closeDialog instead
 */
export const dismissDialog = safeCreateAction('DISMISS_MODAL_DIALOG', identity);

const timers = local<{ [id: string]: NodeJS.Timer }>('notification-timers', {});

type NotificationFunc = (dismiss: NotificationDismiss) => void;
const notificationActions = local<{ [id: string]: NotificationFunc[] }>('notification-actions', {});

export function fireNotificationAction(notiId: string, notiProcess: string,
                                       action: number, dismiss: NotificationDismiss) {
  if (notiProcess === process.type) {
    const func = notificationActions[notiId][action];
    if (func !== undefined) {
      func(dismiss);
    }
  } else {
    // assumption is that notification actions are only triggered by the ui
    // TODO: have to send synchronously because we need to know if we should dismiss
    const res: boolean = ipcRenderer.sendSync('fire-notification-action', notiId, action);
    if (res) {
      dismiss();
    }
  }
}

if (ipcMain !== undefined) {
  ipcMain.on('fire-notification-action',
             (event: Electron.Event, notiId: string, action: number) => {
    event.returnValue = false;
    const func = notificationActions[notiId][action];
    if (func !== undefined) {
      func(() => {
        event.returnValue = true;
      });
    }
  });
}

/**
 * show a notification
 *
 * @export
 * @param {INotification} notification
 * @returns
 */
export function addNotification(notification: INotification) {
  return (dispatch) => {
    const noti = { ...notification };
    if (noti.id === undefined) {
      noti.id = shortid();
    } else if (timers[noti.id] !== undefined) {
      // if this notification is replacing an active one with a timeout,
      // stop that timeout
      clearTimeout(timers[noti.id]);
      delete timers[noti.id];
      delete notificationActions[noti.id];
    }

    notificationActions[noti.id] = noti.actions === undefined
      ? []
      : noti.actions.map(action => action.action);

    const storeNoti: any = JSON.parse(JSON.stringify(noti));
    storeNoti.process = process.type;
    storeNoti.actions = (storeNoti.actions || []).map(action => ({ title: action.title })) as any;

    dispatch(startNotification(storeNoti));
    if (noti.displayMS !== undefined) {
      return new Promise((resolve) => {
        timers[noti.id] = setTimeout(() =>
          resolve()
          , noti.displayMS);
      }).then(() => {
        dispatch(dismissNotification(noti.id));
      });
    }
  };
}

export function dismissNotification(id: string) {
  return dispatch => new Promise<void>((resolve, reject) => {
    delete timers[id];
    delete notificationActions[id];
    dispatch(stopNotification(id));
    resolve();
  });
}

// singleton holding callbacks for active dialogs. The
// actual storage is the "global" object so it gets shared between
// all instances of this module (across extensions).
class DialogCallbacks {
  public static instance(): any {
    if ((global as any).__dialogCallbacks === undefined) {
      (global as any).__dialogCallbacks = {};
    }
    return (global as any).__dialogCallbacks;
  }
}

/**
 * show a dialog
 *
 * @export
 * @param {DialogType} type
 * @param {string} title
 * @param {IDialogContent} content
 * @param {IDialogActions} actions
 * @returns
 */
export function showDialog(type: DialogType, title: string,
                           content: IDialogContent, actions: DialogActions) {
  return (dispatch) => {
    return new Promise<IDialogResult>((resolve, reject) => {
      const id = shortid();
      const defaultAction = actions.find(iter => iter.default === true);
      const defaultLabel = defaultAction !== undefined ? defaultAction.label : undefined;
      dispatch(addDialog(id, type, title, content, defaultLabel,
                         actions.map(action => action.label)));
      DialogCallbacks.instance()[id] = (actionKey: string, input?: any) => {
        const action = actions.find(iter => iter.label === actionKey);
        if (truthy(action.action)) {
          action.action(input);
        }
        resolve({ action: actionKey, input });
      };
    });
  };
}

export function closeDialog(id: string, actionKey: string, input: any) {
  return (dispatch) => {
    dispatch(dismissDialog(id));
    try {
      if (DialogCallbacks.instance()[id] !== null) {
        DialogCallbacks.instance()[id](actionKey, input);
      }
    } catch (err) {
      log('error', 'failed to invoke dialog callback', { id, actionKey });
    } finally {
      delete DialogCallbacks.instance()[id];
    }
  };
}
