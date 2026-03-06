import Store from 'electron-store';

const defaultState = {
  console: {
    address: '',
    port: 51325,
    baseMidiChannel: 12
  },
  tallyConnection: {
    proxyAddress: '',
    wifiSsid: '',
    wifiPassword: ''
  },
  websocketPort: 19188,
  tallyLights: []
};

export class ConfigStore {
  constructor() {
    this.store = new Store({
      name: 'config',
      defaults: defaultState
    });
  }

  get() {
    const value = this.store.store;
    const legacyProxyAddress = String(value?.proxyAddress ?? '');

    return {
      console: {
        address: String(value?.console?.address ?? ''),
        port: Number(value?.console?.port ?? 51325),
        baseMidiChannel: Number(value?.console?.baseMidiChannel ?? 12)
      },
      tallyConnection: {
        proxyAddress: String(value?.tallyConnection?.proxyAddress ?? legacyProxyAddress),
        wifiSsid: String(value?.tallyConnection?.wifiSsid ?? ''),
        wifiPassword: String(value?.tallyConnection?.wifiPassword ?? '')
      },
      websocketPort: Number(value?.websocketPort ?? 19188),
      tallyLights: Array.isArray(value?.tallyLights) ? value.tallyLights : []
    };
  }

  set(nextValue) {
    this.store.store = nextValue;
    return this.get();
  }
}
