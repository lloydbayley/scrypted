import sdk, { Battery, Device, DeviceProvider, EntrySensor, FloodSensor, Lock, LockState, MotionSensor, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SecuritySystem, SecuritySystemMode, TamperSensor } from '@scrypted/sdk';
import { RingCameraDevice } from './camera';
import RingPlugin from './main';
import { Location, LocationMode, RingCamera, RingDevice, RingDeviceData, RingDeviceType } from './ring-client-api';

const { deviceManager } = sdk;

class RingLock extends ScryptedDeviceBase implements Battery, Lock {
    device: RingDevice

    constructor(nativeId: string, device: RingDevice) {
        super(nativeId);
        this.device = device;
        device.onData.subscribe(async (data: RingDeviceData) => {
            this.updateState(data);
        });
    }

    async lock(): Promise<void> {
        return this.device.sendCommand('lock.lock');
    }

    async unlock(): Promise<void> {
        return this.device.sendCommand('lock.unlock');
    }

    updateState(data: RingDeviceData) {
        this.batteryLevel = data.batteryLevel;
        switch (data.locked) {
            case 'locked':
                this.lockState = LockState.Locked;
                break;
            case 'unlocked':
                this.lockState = LockState.Unlocked;
                break;
            case 'jammed':
                this.lockState = LockState.Jammed;
                break;
            default:
                this.lockState = undefined;
        }
    }
}

class RingSensor extends ScryptedDeviceBase implements TamperSensor, Battery, EntrySensor, MotionSensor, FloodSensor {
    constructor(nativeId: string, device: RingDevice) {
        super(nativeId);
        device.onData.subscribe(async (data: RingDeviceData) => {
            this.updateState(data);
        });
    }

    updateState(data: RingDeviceData) {
        this.tampered = data.tamperStatus === 'tamper';
        this.batteryLevel = data.batteryLevel;
        this.entryOpen = data.faulted;
        this.motionDetected = data.faulted;
        this.flooded = data.flood?.faulted || data.faulted;
    }
}

export class RingLocationDevice extends ScryptedDeviceBase implements DeviceProvider, SecuritySystem {
    location: Location;
    devices = new Map<string, any>();
    locationDevices = new Map<string, RingDevice | RingCamera>();

    constructor(public plugin: RingPlugin, nativeId: string, location: Location) {
        super(nativeId);
        this.location = location;

        const updateLocationMode = (f: LocationMode) => {
            let mode: SecuritySystemMode;
            if (f === 'away')
                mode = SecuritySystemMode.AwayArmed;
            else if (f === 'home')
                mode = SecuritySystemMode.HomeArmed;
            else
                mode = SecuritySystemMode.Disarmed;

            let supportedModes = [
                SecuritySystemMode.Disarmed,
                SecuritySystemMode.AwayArmed,
                SecuritySystemMode.HomeArmed
            ]
            if (plugin.settingsStorage.values.nightModeBypassAlarmState !== 'Disabled') {
                supportedModes.push(SecuritySystemMode.NightArmed)
            }

            this.securitySystemState = {
                mode,
                // how to get this?
                triggered: false,
                supportedModes
            }
        }
        this.location.onLocationMode.subscribe(updateLocationMode);
        
        // if the location has a base station, updates when arming/disarming are not sent to the `onLocationMode` subscription
        // instead we subscribe to the security panel, which is updated during arming actions
        this.location.getSecurityPanel().then(panel => {
            panel.onData.subscribe(_ => { 
                this.location.getLocationMode().then(response => {
                    updateLocationMode(response.mode);
                });
            });
        }).catch(error => {
            // could not find a security panel for location
            // not logging this error as it is a valid case to not have a security panel
        });

        if (this.location.hasAlarmBaseStation) {
            this.location.getLocationMode().then(response => {
                updateLocationMode(response.mode);
            });

            if (!this.securitySystemState) {
                updateLocationMode('disabled');
            }
        }

        this.discoverDevices();
    }

    async discoverDevices() {
        this.locationDevices.clear();
        const devices: Device[] = [];
        const cameras = this.location.cameras;
        for (const camera of cameras) {
            const nativeId = camera.id.toString();
            const interfaces = [
                ScryptedInterface.Camera,
                ScryptedInterface.MotionSensor,
                ScryptedInterface.RTCSignalingChannel,
            ];
            if (!camera.isRingEdgeEnabled) {
                interfaces.push(
                    ScryptedInterface.VideoCamera,
                    ScryptedInterface.Intercom,
                    ScryptedInterface.VideoClips,
                );
            }
            if (camera.operatingOnBattery)
                interfaces.push(ScryptedInterface.Battery);
            if (camera.isDoorbot)
                interfaces.push(ScryptedInterface.BinarySensor);
            if (camera.hasLight)
                interfaces.push(ScryptedInterface.DeviceProvider);
            if (camera.hasSiren)
                interfaces.push(ScryptedInterface.DeviceProvider);
            const device: Device = {
                info: {
                    model: `${camera.model} (${camera.data.kind})`,
                    manufacturer: 'Ring',
                    firmware: camera.data.firmware_version,
                    serialNumber: camera.data.device_id
                },
                providerNativeId: this.location.id,
                nativeId,
                name: camera.name,
                type: camera.isDoorbot ? ScryptedDeviceType.Doorbell : ScryptedDeviceType.Camera,
                interfaces,
            };
            devices.push(device);
            this.locationDevices.set(nativeId, camera);
        }

        const locationDevices = await this.location.getDevices();
        for (const locationDevice of locationDevices) {
            const data: RingDeviceData = locationDevice.data;
            let nativeId: string;
            let type: ScryptedDeviceType;
            let interfaces: ScryptedInterface[] = [];

            if (data.status === 'disabled') {
                continue;
            }

            switch (data.deviceType) {
                case RingDeviceType.ContactSensor:
                case RingDeviceType.RetrofitZone: 
                case RingDeviceType.TiltSensor:
                    nativeId = locationDevice.id.toString() + '-sensor';
                    type = ScryptedDeviceType.Sensor
                    interfaces.push(ScryptedInterface.TamperSensor, ScryptedInterface.EntrySensor);
                    break;
                case RingDeviceType.MotionSensor:
                    nativeId = locationDevice.id.toString() + '-sensor';
                    type = ScryptedDeviceType.Sensor
                    interfaces.push(ScryptedInterface.TamperSensor, ScryptedInterface.MotionSensor);
                    break;
                case RingDeviceType.FloodFreezeSensor:
                case RingDeviceType.WaterSensor:
                    nativeId = locationDevice.id.toString() + '-sensor';
                    type = ScryptedDeviceType.Sensor
                    interfaces.push(ScryptedInterface.TamperSensor, ScryptedInterface.FloodSensor);
                    break;
                default:
                    if (/^lock($|\.)/.test(data.deviceType)) {
                        nativeId = locationDevice.id.toString() + '-lock';
                        type = ScryptedDeviceType.Lock
                        interfaces.push(ScryptedInterface.Lock);
                        break;
                    } else {
                        this.console.debug(`discovered and ignoring unsupported '${locationDevice.deviceType}' device: '${locationDevice.name}'`)
                        continue;
                    }
            }

            if (data.batteryStatus !== 'none')
                interfaces.push(ScryptedInterface.Battery);

            const device: Device = {
                info: {
                    model: data.deviceType,
                    manufacturer: 'Ring',
                    serialNumber: data.serialNumber ?? 'Unknown'
                },
                providerNativeId: this.location.id,
                nativeId: nativeId,
                name: locationDevice.name,
                type: type,
                interfaces,
            };
            devices.push(device);
            this.locationDevices.set(nativeId, locationDevice);
        }

        await deviceManager.onDevicesChanged({
            providerNativeId: this.location.id,
            devices: devices,
        });
    }

    async getDevice(nativeId: string) {
        if (!this.devices.has(nativeId)) {
            if (nativeId.endsWith('-sensor')) {
                const device = new RingSensor(nativeId, this.locationDevices.get(nativeId) as RingDevice);
                this.devices.set(nativeId, device);
            } else if (nativeId.endsWith('-lock')) {
                const device = new RingLock(nativeId, this.locationDevices.get(nativeId) as RingDevice);
                this.devices.set(nativeId, device);
            } else {
                const device = new RingCameraDevice(this.plugin.api, nativeId, this.locationDevices.get(nativeId) as RingCamera);
                this.devices.set(nativeId, device);
            }
        }
        return this.devices.get(nativeId);
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {}

    async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        if (mode === SecuritySystemMode.AwayArmed) {
            await this.location.armAway();
        }
        else if (mode === SecuritySystemMode.HomeArmed) {
            await this.location.armHome();
        }
        else if (mode === SecuritySystemMode.NightArmed) {
            const bypassContactSensors = Object.values(this.locationDevices).filter(device => {
                return ((device.deviceType === RingDeviceType.ContactSensor || device.deviceType === RingDeviceType.RetrofitZone) && device.data.faulted)
            }).map(sensor => sensor.id);
        
            if (this.plugin.settingsStorage.values.nightModeBypassAlarmState === 'Away') {
                await this.location.armAway(bypassContactSensors);
            } else {
                await this.location.armHome(bypassContactSensors);
            }
        }
        else if (mode === SecuritySystemMode.Disarmed) {
            await this.location.disarm();
        }
    }

    async disarmSecuritySystem(): Promise<void> {
        await this.location.disarm();
    }
}
