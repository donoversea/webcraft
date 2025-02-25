"use strict";

import {PlayerControlManager} from "@client/control/player_control_manager.js";
import type {PacketBuffer} from "@client/packet_compressor.js";
import {
    MAX_PACKET_AHEAD_OF_TIME_MS, MAX_PACKET_LAG_SECONDS, PHYSICS_INTERVAL_MS, PHYSICS_POS_DECIMALS,
    PLAYER_STATUS, DEBUG_LOG_PLAYER_CONTROL, DEBUG_LOG_PLAYER_CONTROL_DETAIL, PHYSICS_MAX_TICKS_PROCESSED
} from "@client/constant.js";
import type {ServerPlayer} from "../server_player.js";
import {
    DONT_VALIDATE_AFTER_MODE_CHANGE_MS, PLAYER_EXHAUSTION_PER_BLOCK, SERVER_SEND_CMD_MAX_INTERVAL,
    SERVER_UNCERTAINTY_SECONDS, SIMULATE_PLAYER_PHYSICS, WAKEUP_MOVEMENT_DISTANCE
} from "../server_constant.js";
import {ServerClient} from "@client/server_client.js";
import {ArrayHelpers, MonotonicUTCDate, SimpleQueue, Vector} from "@client/helpers.js";
import {ServerPlayerTickData} from "./server_player_tick_data.js";
import {PlayerControlCorrectionPacket, PlayerControlPacketReader, PlayerControlSessionPacket} from "@client/control/player_control_packets.js";
import type {PlayerTickData} from "@client/control/player_tick_data.js";
import {LimitedLogger} from "@client/helpers/limited_logger.js";
import {PLAYER_TICK_MODE} from "@client/control/player_tick_data.js";
import type {WorldAction} from "@client/world_action.js";
import type {ICmdPickatData} from "@client/pickat.js";

const MAX_ACCUMULATED_DISTANCE_INCREMENT = 1.0 // to handle sudden big pos changes (if they ever happen)
const MAX_CLIENT_QUEUE_LENGTH = MAX_PACKET_LAG_SECONDS * 1000 / PHYSICS_INTERVAL_MS | 0 // a protection against memory leaks if there is garbage input

/**
 * Если true, то при малом отличии данных клиента от сервера (см. {@link ACCEPTABLE_PLAYER_POS_ERROR} и т.п.)
 * сервер сохраняет у себя данные клиента. Т.е. ошибка на сервере не накапливаются. Меньше коррекций, но
 * возможность читерства.
 *
 * Если false, то сервер в такой ситуации не шлет коррекцию (пока ошибка не станет больше порогового значения),
 * но и не сохраняет у себя данные клиента. Читерство невозможно, но возможно больше коррекций из-за ошибок
 * окргления и подобного (в идеале их не должно быть быть, но может быть есть).
 */
const ACCEPT_SMALL_CLIENT_ERRORS = true

/** Через сколько секунд удалять элементы из {@link ServerPlayerControlManager.controlEventsExecuted}. Если это происходит, это не нормально. */
const UNUSED_EVENTS_TTL_SECONDS = 180

// @ts-expect-error
export class ServerPlayerControlManager extends PlayerControlManager<ServerPlayer> {
    private lastData: ServerPlayerTickData
    private newData = new ServerPlayerTickData()
    private controlPacketReader = new PlayerControlPacketReader(ServerPlayerTickData)
    private correctionPacket = new PlayerControlCorrectionPacket()

    // Data from client. Some of it may be waiting for WorldAction to be executed
    private clientDataQueue = new SimpleQueue<ServerPlayerTickData>()

    /**
     * id недавно выполненнхы событий, с которыми связана синронизация управления.
     * Они удаляются когда их встречает ссылающийся на них {@link PlayerTickData}, пришедший с клиента.
     * См. общее описание синхронизации в doc/player_control.md
     */
    private controlEventsExecuted: {
        id: int,
        tick: int,
        performanceNow: number // it's to delete old records
    }[] = []

    /** {@see DONT_VALIDATE_AFTER_MODE_CHANGE_MS} */
    private maxUnvalidatedPhysicsTick: int = -Infinity

    /**
     * All client's physics ticks in the current session up to this number are processed and/or skipped.
     * A client can't send data to these ticks again, only to the later ticks.
     */
    private clientPhysicsTicks: int
    private accumulatedExhaustionDistance = 0
    private accumulatedSleepSittingDistance = 0
    private lastCmdSentTime = performance.now()
    private lastStandUpFixTime = -Infinity
    private logger: LimitedLogger
    private fineLogger: LimitedLogger

    constructor(player: ServerPlayer) {
        super(player)
        this.logger = new LimitedLogger({
            prefix: 'Control: ',
            minInterval: 3000,
            player,
            printKeyFn: (key, username) => `@${username} `,
            debugValueSendLog: 'SEND_LOG_PLAYER_CONTROL',
            debugValueEnabled: 'DEBUG_LOG_PLAYER_CONTROL',
            debugValueShowSkipped: 'SHOW_SKIPPED',
            enabled: DEBUG_LOG_PLAYER_CONTROL,
            consoleDisabled: true
        })
        this.fineLogger = new LimitedLogger({
            ...this.logger.options,
            minInterval: 0,
            printKeyFn: null,
            enabled: DEBUG_LOG_PLAYER_CONTROL_DETAIL,
            debugValueSendLog: 'SEND_LOG_PLAYER_CONTROL_DETAIL',
            debugValueEnabled: 'DEBUG_LOG_PLAYER_CONTROL_DETAIL'
        })
        // super constructor doesn't call these methods correctly, so call them here
        this.physicsSessionId = -1 // revert to what it was before the super constructor
        const pos = new Vector(player.sharedProps.pos)
        this.updateCurrentControlType(false)
        this.startNewPhysicsSession(pos)
    }

    get serverPlayer(): ServerPlayer { return this.player as any as ServerPlayer }

    /** The current physics tick according to the clock. The actual tick for which the state is known usually differs. */
    private getPhysicsTickNow(): int {
        return Math.floor((MonotonicUTCDate.now() - this.baseTime) / PHYSICS_INTERVAL_MS)
    }

    updateCurrentControlType(notifyClient: boolean): boolean {
        if (!super.updateCurrentControlType(notifyClient)) {
            return false
        }
        this.maxUnvalidatedPhysicsTick = this.knownPhysicsTicks + Math.floor(DONT_VALIDATE_AFTER_MODE_CHANGE_MS / PHYSICS_INTERVAL_MS)
        this.updateLastData()
        if (notifyClient) {
            // Send the correction to the client, which may or may not be needed.
            // An example when it's needed: a player was flying as a spectator, then started falling.
            // The client continues to fly (when it shouldn't), but it will be corrected soon.
            // Don't wait until we receive the wrong coordinates from the client.
            this.sendCorrection('update_control_type')
        }
        return true
    }

    startNewPhysicsSession(pos: IVector): void {
        super.startNewPhysicsSession(pos)
        this.updateLastData()
        this.maxUnvalidatedPhysicsTick = -Infinity // clear the previous value, otherwise validation might be disabled for a long time
        this.clientPhysicsTicks = 0
        if (this.controlEventsExecuted) { // if the subclass constructor finished
            this.controlEventsExecuted.length = 0
        }
    }

    setPos(pos: IVector): this {
        super.setPos(pos)
        this.player.state.pos.copyFrom(pos)
        return this
    }

    /**
     * Синхронизиует управление с собитием, см. {@link ClientPlayerControlManager.syncWithEventId}.
     * Можно вызывать как сразу до так и сразу после изменений состояния игрока (без await между ними!).
     * Конкретно: запоминает что обытие произошло. Если уже есть (или когда будут) клиентские данные,
     * ссылающиеся на это событие, сервер на них сможет ответить, и симуляция сможет продолжиться.
     */
    syncWithEventId(controlEventId: int | null): this {
        if (controlEventId != null) {
            this.controlEventsExecuted.push({
                id: controlEventId,
                tick: this.knownPhysicsTicks,
                performanceNow: performance.now()
            })
        }
        return this
    }

    /**
     * Если {@link event} содержит поле controlEventId: делает то же, что и {@link syncWithEventId} и
     * удаляет это поле (чтобы ненароком 2-й раз не вызывали). Этот метод просто для удобства.
     */
    syncWithEvent(event: ICmdPickatData | WorldAction): void {
        if (event.controlEventId != null) {
            this.syncWithEventId(event.controlEventId)
            event.controlEventId = null
        }
    }

    onClientSession(data: PlayerControlSessionPacket): void {
        if (data.sessionId !== this.physicsSessionId) {
            return // it's for another session, skip it
        }
        if (this.physicsSessionInitialized) {
            throw 'this.physicsSessionInitialized'
        }
        const now = MonotonicUTCDate.now()
        if (data.baseTime > now + MAX_PACKET_AHEAD_OF_TIME_MS) {
            throw `baseTime > now + MAX_PACKET_AHEAD_OF_TIME_MS ${data.baseTime} ${now} ${Date.now()}`
        }
        // ensure the server doesn't freeze on calculations
        if (data.baseTime < now - MAX_PACKET_LAG_SECONDS * 1000) {
            throw `baseTime < now - MAX_PACKET_LAG_SECONDS * 1000 ${data.baseTime} ${now} ${Date.now()}`
        }
        this.physicsSessionInitialized = true
        this.baseTime = data.baseTime
    }

    /**
     * Adds the client ticks' data to the queue.
     * Executes some physics ticks if possible.
     */
    onClientTicks(buf: PacketBuffer): void {
        const reader = this.controlPacketReader

        // check if it's for the current session
        const [header, ticksData] = reader.readPacket(buf)
        if (header.physicsSessionId !== this.physicsSessionId) {
            this.log('skip_session', `skipping physics session ${header.physicsSessionId} !== ${this.physicsSessionId}`)
            return // it's from the previous session. Ignore it.
        }

        if (!this.physicsSessionInitialized) { // we should have received CMD_PLAYER_CONTROL_SESSION first
            throw '!this.physicsSessionInitialized'
        }

        for(const clientData of ticksData) {
            this.fineLog(() => `received ${clientData}`)
            this.clientDataQueue.push(clientData)
        }

        // Move the player ASAP.
        // It ensures that the player has moved before its next WorldAction is processed, and WorldActions don't have
        // to wait for the physics (e.g. for the player to come close to a block).
        this.tick()
    }

    /**
     * It must be called regularly.
     * It executes player's input, and processes changes that are not a direct result of the player's input, e.g.
     * - if the player is lagging too much, do the old player ticks even without knowing the input
     * - detect external position/velocity/sleep/etc. changes and send a correction
     * @see SERVER_UNCERTAINTY_SECONDS
     */
    tick(): void {
        const player = this.serverPlayer
        if (player.status !== PLAYER_STATUS.ALIVE || !this.physicsSessionInitialized) {
            this.doGarbageCollection()
            return // there is nothing to do until the next physics session starts
        }

        const clientDataQueue = this.clientDataQueue
        const physicsTickNow = this.getPhysicsTickNow()
        const maxAllowedPhysicsTick = physicsTickNow + Math.ceil(MAX_PACKET_AHEAD_OF_TIME_MS / PHYSICS_INTERVAL_MS)
        let correctionReason: string | null = null // если не null, но нужно выслать коррекцию, и эта строка - ее причина
        let needResponse = false // если клиенту нужен ответ (любой) - коррекция или подтверждение

        const debugValueSimulatePhysics = player.debugValues.get('simulatePhysics')
        let simulatePhysics = debugValueSimulatePhysics
            ? debugValueSimulatePhysics === 'true'
            : SIMULATE_PLAYER_PHYSICS
        // Чтобы клиент не переписал внешние серверные изменения своими данными: если такие изменения есть,
        // то несмотря на настройки, симулировать физику вместо принятия данных клиента.
        simulatePhysics ||= this.detectAnyExternalChanges() != null

        this.updateControlFromPlayerState()

        // do ticks for severely lagging clients without their input
        let hasNewData = this.doServerTicks(physicsTickNow - Math.floor(SERVER_UNCERTAINTY_SECONDS * 1000 / PHYSICS_INTERVAL_MS))

        let processedClientData = false
        while(clientDataQueue.length) {
            const clientData = clientDataQueue.getFirst()

            if (clientData.physicsSessionId !== this.physicsSessionId || // it's from the previous session
                // or it's from the current session, but this session will end when the player is resurrected and/or teleported
                player.status !== PLAYER_STATUS.ALIVE
            ) {
                clientDataQueue.shift()
                continue
            }

            // validate time, update this.clientPhysicsTicks
            const newClientPhysicsTicks = clientData.endPhysicsTick
            if (newClientPhysicsTicks > maxAllowedPhysicsTick) {
                player.terminate(`newClientPhysicsTicks > maxClientTickAhead ${newClientPhysicsTicks} ${maxAllowedPhysicsTick}`)
                return
            }
            if (clientData.startingPhysicsTick < this.clientPhysicsTicks) {
                player.terminate(`clientData.startingPhysicsTick < this.clientPhysicsTicks ${clientData.startingPhysicsTick} ${this.clientPhysicsTicks}`)
                return
            }

            // check if the data is at least partially outside the time window where the changes are still allowed
            if (clientData.startingPhysicsTick < this.knownPhysicsTicks) {
                const canSimulateTicks = newClientPhysicsTicks - this.knownPhysicsTicks
                // if it's completely outdated
                if (canSimulateTicks <= 0) {
                    this.clientPhysicsTicks = newClientPhysicsTicks
                    clientDataQueue.shift()
                    continue
                }
                // The data is partially outdated. Remove its older part, leave the most recent part.
                clientData.physicsTicks = canSimulateTicks
                clientData.startingPhysicsTick = this.knownPhysicsTicks

                // check if ticks are skipped in the client data sequence
            } else if (clientData.startingPhysicsTick > this.knownPhysicsTicks) {
                // It happens, e.g. when the client skips simulating physics ticks (we could have sent a message in this case, but we don't)
                // It may also happen due to bugs.
                if (!this.doServerTicks(clientData.startingPhysicsTick)) {
                    break // can't simulate, the chunk is missing
                }
                correctionReason = 'skipped_ticks' // пропустили тики, значит ожидается что данные могут отличаться от клиента
                hasNewData = true
            }

            // check if it's waiting for control events
            if (clientData.inputEventIds) {
                // if an action was executed, and a tick data was waiting for it, remove this action's id from both lists
                ArrayHelpers.filterSelf(this.controlEventsExecuted, (v) =>
                    !ArrayHelpers.fastDeleteValue(clientData.inputEventIds, v.id)
                )
                // if the tick data is still waiting for an action
                if (clientData.inputEventIds.length) {
                    break
                }
            }

            this.clientPhysicsTicks = newClientPhysicsTicks
            clientDataQueue.shift() // the data will be processed, so extract it from the queue

            // data used in the simulation
            const newData = this.newData
            newData.copyInputFrom(clientData)
            newData.initContextFrom(this)

            // Do the simulation if it's needed
            let simulatedSuccessfully: boolean
            if (clientData.inputEventIds) {
                // в этих данных клиент ожидает внешнего изменения (и раз эта строка выполняется - то дождался). Не выполнять симуляцию.
                newData.initOutputFrom(this.current)
                this.onSimulation(this.lastData.outPos, newData)
                this.updateLastData(newData)
                simulatedSuccessfully = true
                needResponse = true
            } else if (this.current === this.spectator ||
                !simulatePhysics ||
                this.knownPhysicsTicks <= this.maxUnvalidatedPhysicsTick
            ) {
                simulatedSuccessfully = false
            } else {
                simulatedSuccessfully = this.simulate(this.lastData, newData)
            }
            this.knownPhysicsTicks = this.clientPhysicsTicks

            if (simulatedSuccessfully) {
                // Accept the server state on the server. We may or may not correct the client.
                const contextEqual = newData.contextEqual(clientData)
                const clientDataMatches = contextEqual && newData.outputSimilar(clientData)
                if (clientDataMatches) {
                    this.fineLog(`    simulation matches ${newData}`)
                    correctionReason = null
                    if (ACCEPT_SMALL_CLIENT_ERRORS) {
                        newData.copyOutputFrom(clientData)
                    }
                } else if (clientData.inputEventIds) {
                    // Клиент ожидал серверного действия. В зависимости от типа действия результат должен был совпасть или нет.
                    // Мы не различаем такие ситуации (не видно нужды в этом). Это ок, что не совпало.
                    this.fineLog(`    simulation with inputWorldActionIds doesn't match ${clientData} ${newData}`)
                    correctionReason = 'simulation_differs inputWorldActionIds'
                } else if (!contextEqual) {
                    // На сервере переключили режим игры или что-то подобное. Это только сервер может делать. Несовпадение ожидаемо.
                    DEBUG_LOG_PLAYER_CONTROL_DETAIL && this.log('simulation_context_differs', () => `    simulation context doesn't match ${newData}`)
                    correctionReason = 'context_differs'
                    // Устранение рассинхронизаци, которая не должна обычно возникать, но может возникнуть из-за багов
                    if (clientData.contextTickMode === PLAYER_TICK_MODE.SITTING_OR_LYING &&
                        newData.contextTickMode !== PLAYER_TICK_MODE.SITTING_OR_LYING &&
                        this.lastStandUpFixTime < performance.now() - 2000
                    ) {
                        player.standUp()
                        this.lastStandUpFixTime = performance.now()
                    }
                } else {
                    // Возможно, отличия вызываны действиями других игроков, мобов или багом.
                    // Это единственный случай несовпадения, который мы не ожидаем.
                    this.log('simulation_differs', () => `    simulation doesn't match ${clientData} ${newData}`)
                    correctionReason = 'simulation_differs'
                }
            } else {
                newData.copyOutputFrom(clientData)
                correctionReason = this.onWithoutSimulation() ? null : 'without_simulation'
            }
            hasNewData = true
            processedClientData = true
        }

        if (!hasNewData) {
            // Если есть внешнее изменение которое ожидаемо клиентом, создать данные тика, содержашие его
            correctionReason = this.detectAndApplyUnexpectedExternalChanges()
            hasNewData = correctionReason != null
        }
        if (hasNewData) {
            player.driving?.applyToDependentParticipants()

            this.lastData.applyOutputToPlayer(player)
            if (correctionReason) {
                this.log('correction', () => `Control ${this.username}: sending correction ${correctionReason}`)
                this.sendCorrection(correctionReason)
            } else if (needResponse || this.lastCmdSentTime < performance.now() - SERVER_SEND_CMD_MAX_INTERVAL) {
                player.sendPackets([{
                    name: ServerClient.CMD_PLAYER_CONTROL_ACCEPTED,
                    data: this.knownPhysicsTicks
                }])
                this.lastCmdSentTime = performance.now()
            }
        }

        this.doGarbageCollection()
    }

    /**
     * Increases {@link knownPhysicsTicks} up to {@link tickMustBeKnown}, if it's less than that.
     * @return true if anything changed
     */
    private doServerTicks(tickMustBeKnown: int): boolean {
        const prevKnownPhysicsTicks = this.knownPhysicsTicks
        let physicsTicks = tickMustBeKnown - this.knownPhysicsTicks
        if (physicsTicks <= 0) {
            return false
        }

        const newData = this.newData
        newData.initInputEmpty(this.lastData, this.knownPhysicsTicks, physicsTicks)
        newData.initContextFrom(this)

        const skipPhysicsTicks = physicsTicks - PHYSICS_MAX_TICKS_PROCESSED
        if (skipPhysicsTicks > 0) {
            this.log('skip_ticks', `skipping ${skipPhysicsTicks} ticks`)
            this.knownPhysicsTicks += skipPhysicsTicks
            physicsTicks = PHYSICS_MAX_TICKS_PROCESSED
            // these skipped ticks become the last data
            newData.initOutputFrom(this.current)
            this.updateLastData()
            // prepare to simulate new ticks
            newData.initInputEmpty(this.lastData, this.knownPhysicsTicks, physicsTicks)
        }

        if (DEBUG_LOG_PLAYER_CONTROL_DETAIL) {
            this.log('without_input', `simulate ${physicsTicks} ticks without client's input`)
        }

        if (this.current === this.spectator) {
            // no simulation
            newData.initOutputFrom(this.spectator)
            this.updateLastData(newData)
            this.knownPhysicsTicks = tickMustBeKnown
        } else {
            if (this.simulate(this.lastData, newData)) {
                this.knownPhysicsTicks = tickMustBeKnown
            } else {
                this.log('without_input_failed', `    simulation without client's input failed`)
            }
        }

        return this.knownPhysicsTicks !== prevKnownPhysicsTicks
    }

    /**
     * Обнаруживает изменения состяония, произведеные чем-то извне.
     * @return null если нет изменений, иначе строка, описывающая тип изменений (она же - причина коррекции клиенту, если таковая будет)
     */
    private detectAnyExternalChanges(): string | null {
        const lastData = this.lastData
        const newData = this.newData
        newData.initContextFrom(this)
        newData.initOutputFrom(this.current)
        return !lastData.outputSimilar(newData)
            ? 'external_change'
            : (lastData.contextEqual(newData) ? null : 'external_context_change')
    }

    /**
     * Обнаруживает неожиданные (т.е. не содержащиеся в {@link controlEventsExecuted}) изменения состояния
     * игрока, произведеные чем-то извне и создает даные тика с этими изменениями.
     * @return то же, что и у {@link detectAnyExternalChanges}
     */
    private detectAndApplyUnexpectedExternalChanges(): string | null {
        // если knownPhysicsTicks слишком далеко в будущее, и мы не можем пока создать новый тик - ничего не делать, ждать
        if (this.knownPhysicsTicks > Math.max(this.clientPhysicsTicks, this.getPhysicsTickNow())) {
            return null
        }
        // если это изменение связано с событием, то оно ожидаемо клиентом, и должно быть обработано вместе с соответствующими данными тика
        if (this.controlEventsExecuted.find(it => it.tick === this.knownPhysicsTicks)) {
            return null
        }
        const result = this.detectAnyExternalChanges()
        if (result) {
            if (DEBUG_LOG_PLAYER_CONTROL_DETAIL || result === 'external_change') {
                this.log(result, () => `detected ${result} ${this.lastData} -> ${this.newData}`)
            }
            this.newData.initInputEmpty(this.lastData, this.knownPhysicsTicks, 1)
            this.knownPhysicsTicks++
            this.updateLastData(this.newData)
        }
        return result
    }

    private doGarbageCollection(): void {
        // prevent memory leak if something goes wrong
        while (this.clientDataQueue.length > MAX_CLIENT_QUEUE_LENGTH) {
            this.clientDataQueue.shift()
        }
        // Удалить старые не запрошенные события, для которых не пришло соответствующих данных с клиента.
        // Обычно они удаляются когда с клиента приходят соответствующие данные тиков. Если нет - значит баги.
        // Неизвестно, случается ли это.
        const controlEventsExecuted = this.controlEventsExecuted
        while(controlEventsExecuted.length &&
            controlEventsExecuted[0].performanceNow < performance.now() - UNUSED_EVENTS_TTL_SECONDS * 1000
        ) {
            console.error('unused control event deleted')
            controlEventsExecuted.shift()
        }
    }

    private updateLastData(newData?: ServerPlayerTickData): void {
        const lastData = this.lastData ??= new ServerPlayerTickData()
        if (newData) {
            lastData.copyInputFrom(newData)
            // the simulation may have changed context, e.g. flying, so init context from the player, not from newData
            lastData.initContextFrom(this)
            lastData.copyOutputFrom(newData)
        } else {
            lastData.initInputEmpty(null, this.knownPhysicsTicks - 1, 1)
            lastData.initContextFrom(this)
            lastData.initOutputFrom(this.current)
        }
    }

    /** Sends {@link lastData} as the correction to the client. */
    private sendCorrection(clientLog?: string | null): void {
        if (this.current === this.spectator) {
            return
        }
        const cp = this.correctionPacket
        cp.physicsSessionId = this.physicsSessionId
        cp.knownPhysicsTicks = this.knownPhysicsTicks
        cp.log = clientLog
        cp.data = this.lastData
        this.serverPlayer.sendPackets([{
            name: ServerClient.CMD_PLAYER_CONTROL_CORRECTION,
            data: cp.export()
        }])
        this.lastCmdSentTime = performance.now()
    }

    updatePlayerStateFromControl() {
        const pcState = this.current.player_state
        const playerState = this.player.state

        // TODO maybe more like this.player.changePosition()?

        playerState.pos.copyFrom(pcState.pos)
        playerState.rotate.z = pcState.yaw
    }

    /**
     * It updates the current control according to the changes made by the game to the player's state
     * outside the control simulation.
     * It must be called once before each series of consecutive simulations.
     *
     * We assume {@link current} is already updated and correct.
     */
    private updateControlFromPlayerState() {
        const pcState = this.current.player_state
        const playerState = this.player.state

        // we need to round it, e.g. to avoid false detections of changes after sitting/lying
        pcState.pos.copyFrom(playerState.pos).roundSelf(PHYSICS_POS_DECIMALS)
        pcState.yaw = playerState.rotate.z
    }

    /**
     * Accepts or rejects the {@link newData} received from the client without simulation.
     * If it's rejected, the player's state remain unchanged.
     * @returns true if the data is accepted
     */
    private onWithoutSimulation(): boolean {
        const lastData = this.lastData
        const newData = this.newData
        const pc = this.controlByType[newData.contextControlType]
        let accepted: boolean
        try {
            accepted = pc.validateWithoutSimulation(lastData, newData)
        } catch (e) {
            accepted = false
        }
        if (!accepted) {
            // Either cheating or a bug detected. The previous output remains unchanged.
            newData.copyOutputFrom(lastData)
        }
        this.onSimulation(lastData.outPos, newData)
        this.updateLastData(newData)
        return accepted
    }

    protected simulate(prevData: ServerPlayerTickData | null | undefined, data: ServerPlayerTickData): boolean {
        const res = super.simulate(prevData, data)
        if (res) {
            this.updateLastData(data)
        }
        return res
    }

    protected onSimulation(prevPos: Vector, data: PlayerTickData): void {
        super.onSimulation(prevPos, data)

        const ps = this.player.state
        const sitsOrSleeps = ps.sitting || ps.sleep
        const moved = !prevPos.equal(data.outPos)
        if (!moved) {
            if (!sitsOrSleeps) {
                this.accumulatedSleepSittingDistance = 0
            }
            return
        }

        let distance = Math.min(data.outPos.distance(prevPos), MAX_ACCUMULATED_DISTANCE_INCREMENT)

        if (sitsOrSleeps) {
            // сразу после того как лег/сел, парктически не учитывать перемешение (оно может включать перемещение до кровати)
            if (this.accumulatedSleepSittingDistance === 0) {
                distance = Math.min(distance, 0.001)
            }
            // If the player moved too much while sitting/sleeping, then there is no more chair or a bed under them
            this.accumulatedSleepSittingDistance += distance
            if (this.accumulatedSleepSittingDistance > WAKEUP_MOVEMENT_DISTANCE) {
                this.accumulatedSleepSittingDistance = 0
                this.serverPlayer.standUp()
            }
            return
        }

        // add exhaustion
        this.accumulatedExhaustionDistance += distance
        let accumulatedIntDistance = Math.floor(this.accumulatedExhaustionDistance)
        if (accumulatedIntDistance) {
            const player = this.serverPlayer
            player.state.stats.distance += accumulatedIntDistance
            this.accumulatedExhaustionDistance -= accumulatedIntDistance
            player.addExhaustion(PLAYER_EXHAUSTION_PER_BLOCK * accumulatedIntDistance)
        }
    }

    private log(key: string, msg: string | (() => string)) {
        this.logger.log(key, this.username, msg)
    }

    private fineLog(msg: string | (() => string)) {
        this.fineLogger.log(msg)
    }

}