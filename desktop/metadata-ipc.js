"use strict";
function registerMetadataHandlers(ipcMain, store, assertTrustedRenderer) {
  ipcMain.handle('metadata:get',(event,key)=>{
    assertTrustedRenderer(event,'Read metadata');
    return store.get(key);
  });
  ipcMain.handle('metadata:set',(event,key,value)=>{
    assertTrustedRenderer(event,'Write metadata');
    store.set(key,value);
  });
}
module.exports={registerMetadataHandlers};
