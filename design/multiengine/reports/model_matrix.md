# Dynamic model matrix: ANDES 2.0.0 vs Sienna (PowerSystems 5.12.5, PSID 0.16.2)

Built from the installed sources by `.claude/kimi/model_matrix.py`. "Sienna simulates" means
PSID's model and initialisation code names the PowerSystems type the `.dyr` parser maps to;
it is a static check, and each "both" row still needs a run to confirm (the spike did
GENROU and TGOV1).

Counts: ANDES only: 45, ANDES; Sienna parses only: 6, Sienna only: 11, Sienna parses only: 6, both: 14

| PSS/E name | ANDES group | Sienna types | Sienna simulates | Status |
|---|---|---|---|---|
| ESAC1A | Exciter | AVR: ESAC1A | yes | both |
| ESST1A | Exciter | AVR: ESST1A | yes | both |
| EXAC1 | Exciter | AVR: EXAC1 | yes | both |
| EXST1 | Exciter | AVR: EXST1 | yes | both |
| SEXS | Exciter | AVR: SEXS | yes | both |
| IEEEST | PSS | PSS: IEEEST | yes | both |
| REECB1 | RenExciter | ActivePowerControl: ActiveRenewableControllerAB, ReactivePowerControl: ReactiveRenewableControllerAB, InnerControl: RECurrentControlB | yes | both |
| REGCA1 | RenGen | Converter: RenewableEnergyConverterTypeA | yes | both |
| REPCA1 | RenPlant | ActivePowerControl: ActiveRenewableControllerAB, ReactivePowerControl: ReactiveRenewableControllerAB | yes | both |
| GENCLS | SynGen | Machine: BaseMachine, Shaft: ClsShaft | yes | both |
| GENROU | SynGen | Machine: RoundRotorQuadratic, Shaft: RoundRotorShaft | yes | both |
| GAST | TurbineGov | TurbineGov: GasTG | yes | both |
| HYGOV | TurbineGov | TurbineGov: HydroTurbineGov | yes | both |
| TGOV1 | TurbineGov | TurbineGov: SteamTurbineGov1 | yes | both |
| ESDC1A | Exciter | AVR: ESDC1A | no | ANDES; Sienna parses only |
| ESDC2A | Exciter | AVR: ESDC2A | no | ANDES; Sienna parses only |
| ESST4B | Exciter | AVR: ESST4B | no | ANDES; Sienna parses only |
| EXAC2 | Exciter | AVR: EXAC2 | no | ANDES; Sienna parses only |
| IEEET1 | Exciter | AVR: IEEET1 | no | ANDES; Sienna parses only |
| IEEEG1 | TurbineGov | TurbineGov: IEEETurbineGov1 | no | ANDES; Sienna parses only |
| ESD1 | DG | - | no | ANDES only |
| EV1 | DG | - | no | ANDES only |
| EV2 | DG | - | no | ANDES only |
| PVD1 | DG | - | no | ANDES only |
| DGPRCT1 | DGProtection | - | no | ANDES only |
| DGPRCTExt | DGProtection | - | no | ANDES only |
| FLoad | DynLoad | - | no | ANDES only |
| ZIP | DynLoad | - | no | ANDES only |
| SHAFT5 | DynShaft | - | no | ANDES only |
| AC8B | Exciter | - | no | ANDES only |
| ESAC5A | Exciter | - | no | ANDES only |
| ESST3A | Exciter | - | no | ANDES only |
| EXAC4 | Exciter | - | no | ANDES only |
| EXDC2 | Exciter | - | no | ANDES only |
| IEEET3 | Exciter | - | no | ANDES only |
| IEEEX1 | Exciter | - | no | ANDES only |
| Motor3 | Motor | - | no | ANDES only |
| Motor5 | Motor | - | no | ANDES only |
| PLL1 | PLL | - | no | ANDES only |
| PLL2 | PLL | - | no | ANDES only |
| ST2CUT | PSS | - | no | ANDES only |
| WTARA1 | RenAerodynamics | - | no | ANDES only |
| WTARV1 | RenAerodynamics | - | no | ANDES only |
| REECA1 | RenExciter | - | no | ANDES only |
| REECA1E | RenExciter | - | no | ANDES only |
| REECA1G | RenExciter | - | no | ANDES only |
| REGCP1 | RenGen | - | no | ANDES only |
| REGCV1 | RenGen | - | no | ANDES only |
| REGCV2 | RenGen | - | no | ANDES only |
| REGF1 | RenGen | - | no | ANDES only |
| REGF2 | RenGen | - | no | ANDES only |
| REGF3 | RenGen | - | no | ANDES only |
| WTDS | RenGovernor | - | no | ANDES only |
| WTDTA1 | RenGovernor | - | no | ANDES only |
| WTPTA1 | RenPitch | - | no | ANDES only |
| WTTQA1 | RenTorque | - | no | ANDES only |
| PLBVFU1 | SynGen | - | no | ANDES only |
| HYGOV4 | TurbineGov | - | no | ANDES only |
| HYGOVDB | TurbineGov | - | no | ANDES only |
| IEESGO | TurbineGov | - | no | ANDES only |
| TG2 | TurbineGov | - | no | ANDES only |
| TGOV1DB | TurbineGov | - | no | ANDES only |
| TGOV1N | TurbineGov | - | no | ANDES only |
| TGOV1NDB | TurbineGov | - | no | ANDES only |
| IEEEVC | VoltComp | - | no | ANDES only |
| DEGOV1 | - | TurbineGov: DEGOV1 | yes | Sienna only |
| DERA1 | - | DynamicInjection: AggregateDistributedGenerationA | yes | Sienna only |
| GENROE | - | Machine: RoundRotorExponential, Shaft: RoundRotorShaft | yes | Sienna only |
| GENSAE | - | Machine: SalientPoleExponential, Shaft: SalientPoleShaft | yes | Sienna only |
| GENSAL | - | Machine: SalientPoleQuadratic, Shaft: SalientPoleShaft | yes | Sienna only |
| PIDGOV | - | TurbineGov: PIDGOV | yes | Sienna only |
| SCRX | - | AVR: SCRX | yes | Sienna only |
| ST6B | - | AVR: ST6B | yes | Sienna only |
| ST8C | - | AVR: ST8C | yes | Sienna only |
| STAB1 | - | PSS: STAB1 | yes | Sienna only |
| WPIDHY | - | TurbineGov: WPIDHY | yes | Sienna only |
| ESAC6A | - | AVR: ESAC6A | no | Sienna parses only |
| ESAC8B | - | AVR: ESAC8B | no | Sienna parses only |
| EXAC1A | - | AVR: EXAC1A | no | Sienna parses only |
| EXPIC1 | - | AVR: EXPIC1 | no | Sienna parses only |
| GGOV1 | - | TurbineGov: GeneralGovModel | no | Sienna parses only |
| TGOV1DU | - | TurbineGov: TGOV1DU | no | Sienna parses only |

## Sienna component types PSID's code names that no `.dyr` record maps to

These are reachable only by building the component in code, so they are Sienna-only
capabilities for the neutral language to expose (inverter parts, generic machine and
control types, dynamic lines, induction machines):

`AVRFixed`, `AVRSimple`, `AVRTypeI`, `AVRTypeII`, `ActiveConstantPowerLoad`, `ActivePowerDroop`, `ActivePowerPI`, `ActiveVirtualOscillator`, `AndersonFouadMachine`, `AverageConverter`, `CSVGN1`, `CurrentModeControl`, `DEGOV`, `FiveMassShaft`, `FixedDCSource`, `FixedFrequency`, `FullMachine`, `HybridOutputCurrentLimiter`, `InstantaneousOutputCurrentLimiter`, `KauraPLL`, `LCLFilter`, `Line`, `MagnitudeOutputCurrentLimiter`, `MarconatoMachine`, `OneDOneQMachine`, `PSS2A`, `PSS2B`, `PSS2C`, `PSSFixed`, `PSSSimple`, `PeriodicVariableSource`, `RLFilter`, `ReactivePowerDroop`, `ReactivePowerPI`, `ReactiveVirtualOscillator`, `ReducedOrderPLL`, `RenewableEnergyVoltageConverterTypeA`, `SaturationOutputCurrentLimiter`, `SauerPaiMachine`, `SimpleAFMachine`, `SimpleFullMachine`, `SimpleMarconatoMachine`, `SimplifiedSingleCageInductionMachine`, `SingleCageInductionMachine`, `SingleMass`, `Source`, `StandardLoad`, `TGFixed`, `TGSimple`, `TGTypeI`, `TGTypeII`, `Transformer2W`, `VirtualInertia`, `VoltageModeControl`
