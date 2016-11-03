import * as types from './types';
import * as Promise from 'bluebird';
declare class Nexus {
    private mRestClient;
    private mBaseData;
    private mBaseURL;
    constructor(game: string, apiKey: string);
    setGame(gameId: string): void;
    setKey(apiKey: string): void;
    validateKey(key?: string): Promise<types.IValidateKeyResponse>;
    getGames(): Promise<types.IGameListEntry[]>;
    getGameInfo(gameId?: string): Promise<types.IGameInfo>;
    getModInfo(modId: number, gameId?: string): Promise<types.IModInfo>;
    getModFiles(modId: number, gameId?: string): Promise<types.IFileInfo[]>;
    getFileInfo(modId: number, fileId: number, gameId?: string): Promise<types.IFileInfo>;
    getDownloadURLs(modId: number, fileId: number, gameId?: string): Promise<types.IDownloadURL[]>;
    private filter(obj);
    private handleResult(data, response, resolve, reject);
    private args(customArgs);
    private initMethods();
}
export default Nexus;
