/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import { logger, ShellParser } from '@nordicsemiconductor/pc-nrfconnect-shared';

import { RootState } from '../../../../appReducer';
import BaseNpmDevice from '../basePmicDevice';
import {
    isModuleDataPair,
    MAX_TIMESTAMP,
    NpmEventEmitter,
    parseLogData,
} from '../pmicHelpers';
import {
    AdcSample,
    IrqEvent,
    LoggingEvent,
    NpmExportV2,
    NpmPeripherals,
    PmicDialog,
    USBPower,
} from '../types';
import { BatteryProfiler } from './batteryProfiler';
import BuckModule, { toBuckExport } from './buck';
import ChargerModule from './charger';
import FuelGaugeModule from './fuelGauge';
import GpioModule from './gpio';
import LdoModule, { toLdoExport } from './ldo';
import LowPowerModule from './lowPower';
import overlay from './overlay';
import PofModule from './pof';
import ResetModule from './reset';
import TimerConfigModule from './timerConfig';
import UsbCurrentLimiterModule from './universalSerialBusCurrentLimiter';

export const npm1300FWVersion = '1.3.3+0';

export default class Npm1300 extends BaseNpmDevice {
    constructor(
        shellParser: ShellParser | undefined,
        dialogHandler: ((dialog: PmicDialog) => void) | null,
        peripherals?: Partial<NpmPeripherals>,
        hardwareVersion?: string,
        type: 'npm1300' | 'npm1304' = 'npm1300',
        fw: string = npm1300FWVersion
    ) {
        super(
            type,
            fw,
            shellParser,
            dialogHandler,
            new NpmEventEmitter(),
            {
                ChargerModule,
                noOfLEDs: 3,
                noOfBatterySlots: 3,
                maxEnergyExtraction: false,
                ldos: {
                    Module: LdoModule,
                    count: 2,
                },
                bucks: {
                    Module: BuckModule,
                    count: 2,
                },
                gpios: {
                    Module: GpioModule,
                    count: 5,
                },
                BatteryProfiler,
                PofModule,
                UsbCurrentLimiterModule,
                TimerConfigModule,
                LowPowerModule,
                ResetModule,
                FuelGaugeModule,
                ...peripherals,
            },
            1,
            {
                reset: true,
                charger: true,
                sensor: true,
            },
            hardwareVersion
        );

        if (shellParser) {
            this.releaseAll.push(
                shellParser.onShellLoggingEvent(logEvent => {
                    parseLogData(logEvent, loggingEvent => {
                        switch (loggingEvent.module) {
                            case 'module_pmic':
                                this.processModulePmic(loggingEvent);
                                break;
                            case 'module_pmic_adc':
                                this.processModulePmicAdc(loggingEvent);
                                break;
                            case 'module_pmic_irq':
                                this.processModulePmicIrq(loggingEvent);
                                break;
                            case 'module_pmic_charger':
                                // Handled in charger callbacks
                                break;
                            case 'module_fg':
                                // Handled in fuelGauge callbacks
                                break;
                        }

                        this.eventEmitter.emit('onLoggingEvent', {
                            loggingEvent,
                            dataPair: isModuleDataPair(loggingEvent.module),
                        });
                    });
                })
            );
        }
    }

    private processModulePmic({ message }: LoggingEvent) {
        switch (message) {
            case 'Power Failure Warning':
                this.batteryProfiler?.pofError();
                break;
            case 'No response from PMIC.':
                if (this.pmicState !== 'pmic-disconnected') {
                    this.pmicState = 'pmic-disconnected';
                    this.eventEmitter.emit('onPmicStateChange', this.pmicState);
                }
                break;
            case 'PMIC available. Application can be restarted.':
                if (this.pmicState === 'pmic-pending-rebooting') return;

                if (this.autoReboot) {
                    this.kernelReset();
                    this.pmicState = 'pmic-pending-rebooting';
                    this.eventEmitter.emit('onPmicStateChange', this.pmicState);
                } else if (this.pmicState !== 'pmic-pending-reboot') {
                    this.pmicState = 'pmic-pending-reboot';
                    this.eventEmitter.emit('onPmicStateChange', this.pmicState);
                }
                break;
            case 'No USB connection':
                this.eventEmitter.emit('onUsbPower', {
                    detectStatus: 'No USB connection',
                } as USBPower);
                break;
            case 'Default USB 100/500mA':
                this.eventEmitter.emit('onUsbPower', {
                    detectStatus: 'USB 100/500 mA',
                } as USBPower);
                break;
            case '1.5A High Power':
                this.eventEmitter.emit('onUsbPower', {
                    detectStatus: '1.5A High Power',
                } as USBPower);
                break;
            case '3A High Power':
                this.eventEmitter.emit('onUsbPower', {
                    detectStatus: '3A High Power',
                } as USBPower);
                break;
        }
    }

    private processModulePmicAdc({ timestamp, message }: LoggingEvent) {
        const messageParts = message.split(',');
        const adcSample: AdcSample = {
            timestamp,
            vBat: 0,
            iBat: NaN,
            tBat: 0,
            soc: NaN,
            tte: NaN,
            ttf: NaN,
        };

        const fixed = (dp: number, value?: string | number) =>
            Number(Number(value ?? 0).toFixed(dp));

        messageParts.forEach(part => {
            const pair = part.split('=');
            switch (pair[0]) {
                case 'vbat':
                    adcSample.vBat = fixed(2, pair[1]);
                    break;
                case 'ibat':
                    adcSample.iBat = fixed(2, Number(pair[1] ?? NaN) * 1000);
                    break;
                case 'tbat':
                    adcSample.tBat = fixed(1, pair[1]);
                    break;
                case 'soc':
                    adcSample.soc = Math.min(
                        100,
                        Math.max(0, fixed(1, pair[1]))
                    );
                    break;
                case 'tte':
                    adcSample.tte = Number(pair[1] ?? NaN);
                    break;
                case 'ttf':
                    adcSample.ttf = Number(pair[1] ?? NaN);
                    break;
            }
        });

        if (adcSample.timestamp < this.lastUptime) {
            this.uptimeOverflowCounter += 1;
            adcSample.timestamp += MAX_TIMESTAMP * this.uptimeOverflowCounter;
        }

        this.lastUptime = adcSample.timestamp;

        this.eventEmitter.emit('onAdcSample', adcSample);
    }

    processModulePmicIrq = ({ message }: LoggingEvent) => {
        const messageParts = message.split(',');
        const event: IrqEvent = {
            type: '',
            event: '',
        };
        messageParts.forEach(part => {
            const pair = part.split('=');
            switch (pair[0]) {
                case 'type':
                    event.type = pair[1];
                    break;
                case 'bit':
                    event.event = pair[1];
                    break;
            }
        });

        this.doActionOnEvent(event);
    };

    private doActionOnEvent(irqEvent: IrqEvent) {
        switch (irqEvent.type) {
            case 'EVENTSVBUSIN0SET':
                this.processEventVBus0Set(irqEvent);
                break;
            case 'EVENTSBCHARGER1SET':
                if (irqEvent.event === 'EVENTCHGERROR') {
                    this.eventEmitter.emit('onErrorLogs', {
                        chargerError: [],
                        sensorError: [],
                    });

                    this.shellParser?.enqueueRequest(
                        'npmx errlog get',
                        {
                            onSuccess: res => {
                                let errors: string[] = [];
                                let currentState = '';

                                const emit = () => {
                                    switch (currentState) {
                                        case 'RSTCAUSE:':
                                            this.eventEmitter.emit(
                                                'onErrorLogs',
                                                {
                                                    resetCause: errors,
                                                }
                                            );
                                            logger.warn(
                                                `Reset cause: ${errors.join(
                                                    ', '
                                                )}`
                                            );
                                            break;
                                        case 'CHARGER_ERROR:':
                                            this.eventEmitter.emit(
                                                'onErrorLogs',
                                                {
                                                    chargerError: errors,
                                                }
                                            );
                                            logger.error(
                                                `Charger Errors: ${errors.join(
                                                    ', '
                                                )}`
                                            );
                                            break;
                                        case 'SENSOR_ERROR:':
                                            this.eventEmitter.emit(
                                                'onErrorLogs',
                                                {
                                                    sensorError: errors,
                                                }
                                            );
                                            logger.error(
                                                `Sensor Errors: ${errors.join(
                                                    ', '
                                                )}`
                                            );
                                            break;
                                    }
                                };
                                const split = res?.split('\n');
                                split
                                    ?.map(item => item.trim())
                                    .forEach(item => {
                                        if (item.match(/[A-Z_]+:/)) {
                                            if (currentState) emit();
                                            currentState = item;
                                            errors = [];
                                        } else {
                                            errors.push(item);
                                        }
                                    });

                                emit();
                            },
                            onError: () => {
                                logger.warn(
                                    'error message unable to read error from device'
                                );
                            },
                            onTimeout: () => {
                                logger.warn('Reading latest error timed out.');
                            },
                        },
                        undefined,
                        true
                    );
                }
                break;
            case 'RSTCAUSE':
                this.eventEmitter.emit('onErrorLogs', {
                    resetCause: [irqEvent.event],
                });
                logger.warn(`Reset cause: ${irqEvent.event}`);
                break;
        }
    }

    private processEventVBus0Set(irqEvent: IrqEvent) {
        switch (irqEvent.event) {
            case 'EVENTVBUSREMOVED':
                this.eventEmitter.emit('onUsbPowered', false);
                break;
            case 'EVENTVBUSDETECTED':
                this.eventEmitter.emit('onUsbPowered', true);
                break;
        }
    }

    release() {
        super.release();
        this.batteryProfiler?.release();
        this.releaseAll.forEach(release => release());
    }

    // eslint-disable-next-line class-methods-use-this
    get canUploadBatteryProfiles() {
        return true;
    }

    // eslint-disable-next-line class-methods-use-this
    generateExport(
        getState: () => RootState & {
            app: { pmicControl: { npmDevice: BaseNpmDevice } };
        }
    ) {
        const currentState = getState().app.pmicControl;

        return {
            boosts: [...currentState.boosts],
            charger: currentState.charger,
            bucks: [...currentState.bucks.map(toBuckExport)],
            ldos: [...currentState.ldos.map(toLdoExport)],
            gpios: [...currentState.gpios],
            leds: [...currentState.leds],
            pof: currentState.pof,
            lowPower: currentState.lowPower,
            reset: currentState.reset,
            timerConfig: currentState.timerConfig,
            fuelGaugeSettings: {
                enabled: currentState.fuelGaugeSettings.enabled,
                chargingSamplingRate:
                    currentState.fuelGaugeSettings.chargingSamplingRate,
            },
            firmwareVersion: currentState.npmDevice.supportedVersion,
            deviceType: currentState.npmDevice.deviceType,
            usbPower: currentState.usbPower
                ? { currentLimiter: currentState.usbPower.currentLimiter }
                : undefined,
            fileFormatVersion: 2 as const,
        };
    }

    generateOverlay(npmExport: NpmExportV2) {
        return overlay(npmExport, this);
    }
}
