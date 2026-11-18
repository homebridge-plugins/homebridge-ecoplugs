'use strict';

// Minimal in-memory stand-ins for the parts of the Homebridge/HAP API the platform touches.
// Enough to construct EcoPlugPlatform and drive seedStaticDevices()/handleDiscoveredDevice()
// without a real Homebridge, and without starting any network activity (that only begins in
// the `didFinishLaunching` handler, which these tests never fire).

const Service = {
  AccessoryInformation: Symbol('AccessoryInformation'),
  Outlet: Symbol('Outlet'),
  Switch: Symbol('Switch'),
};

const Characteristic = {
  On: Symbol('On'),
  Name: Symbol('Name'),
  Manufacturer: Symbol('Manufacturer'),
  Model: Symbol('Model'),
  SerialNumber: Symbol('SerialNumber'),
  FirmwareRevision: Symbol('FirmwareRevision'),
};

class FakeCharacteristic {
  constructor() { this.value = undefined; }
  onSet() { return this; }
  onGet() { return this; }
  updateValue(value) { this.value = value; return this; }
}

class FakeService {
  constructor(type) {
    this.type = type;
    this.characteristics = new Map();
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type)) this.characteristics.set(type, new FakeCharacteristic());
    return this.characteristics.get(type);
  }

  setCharacteristic(type, value) {
    this.getCharacteristic(type).updateValue(value);
    return this;
  }
}

class FakePlatformAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.context = {};
    this.services = [new FakeService(Service.AccessoryInformation)];
  }

  getService(type) { return this.services.find((s) => s.type === type); }

  addService(type) {
    const service = new FakeService(type);
    this.services.push(service);
    return service;
  }

  removeService(service) { this.services = this.services.filter((s) => s !== service); }

  on() { return this; }
}

function makeApi() {
  return {
    hap: { Service, Characteristic, uuid: { generate: (seed) => `uuid-${seed}` } },
    platformAccessory: FakePlatformAccessory,
    on() {},
    registerPlatformAccessories() {},
    unregisterPlatformAccessories() {},
  };
}

/** A Homebridge-style logger that records every line as `level: message`. */
function makeLogger() {
  const logs = [];
  const line = (level) => (...args) => { logs.push(`${level}: ${args.join(' ')}`); };
  const log = {
    info: line('info'), warn: line('warn'), error: line('error'), debug: line('debug'),
    success: line('info'), log: line('info'),
  };
  return { log, logs };
}

module.exports = { makeApi, makeLogger };
