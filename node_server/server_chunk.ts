import { CHUNK_STATE } from "@client/chunk_const.js";
import { ServerClient } from "@client/server_client.js";
import { DIRECTION, SIX_VECS, Vector, VectorCollector } from "@client/helpers.js";
import { ChestHelpers, RIGHT_NEIGBOUR_BY_DIRECTION } from "@client/block_helpers.js";
import { newTypedBlocks, TBlock, TypedBlocks3 } from "@client/typed_blocks3.js";
import {dropBlock, TActionBlock, WorldAction} from "@client/world_action.js";
import { COVER_STYLE_SIDES, DEFAULT_MOB_TEXTURE_NAME, MOB_TYPE } from "@client/constant.js";
import { compressWorldModifyChunk } from "@client/compress/world_modify_chunk.js";
import { FLUID_STRIDE, FLUID_TYPE_MASK, FLUID_LAVA_ID, OFFSET_FLUID, FLUID_WATER_ID } from "@client/fluid/FluidConst.js";
import { DelayedCalls } from "./server_helpers.js";
import { MobGenerator } from "./mob/generator.js";
import { TickerHelpers } from "./ticker/ticker_helpers.js";
import { ChunkLight } from "@client/light/ChunkLight.js";
import type { ServerWorld } from "./server_world.js";
import type { ServerPlayer } from "./server_player.js";
import type { Mob, MobSpawnParams } from "./mob.js";
import type { DropItem } from "./drop_item.js";
import type { ServerChunkManager } from "./server_chunk_manager.js";
import { FluidChunkQueue } from "@client/fluid/FluidChunkQueue.js";
import type { DBItemBlock } from "@client/blocks";
import type { ChunkDBActor } from "./db/world/ChunkDBActor.js";

const _rnd_check_pos = new Vector(0, 0, 0);
const tmpRandomTickerTBlock = new TBlock()

export interface ServerModifyList {
    compressed?         : BLOB
    private_compressed? : BLOB
    obj? : {
        [key: string]: DBItemBlock
    }
}

/** One row of "chunks" table, with additional in-memory fields */
export interface ChunkRecord {
    // DB fields:
    mobs_is_generated   : int // 0 or 1
    delayed_calls       : string | null

    // additional fields
    exists  : boolean   // whether the record exists in db
    chunk?  : ServerChunk
    dirty?  : boolean
}

/** A non-random ticker */
export type TTickerFunction = (
    manager: TickingBlockManager, tick_number: int, world: ServerWorld, chunk: ServerChunk,
    v: TickingBlock, check_pos: Vector, ignore_coords: VectorCollector
) => (TActionBlock | null)[] | TActionBlock | null

export type TRandomTickerFunction = (
    world: ServerWorld, actions: WorldAction, world_light: number, tblock: TBlock) => void

// Ticking block
class TickingBlock {

    #chunk : ServerChunk;
    pos: Vector;
    ticking: IBlockMaterialTicking;
    ticker: TTickerFunction;
    _preloadFluidBuf: any;
    private tmpTBlock = new TBlock()

    constructor(chunk: ServerChunk) {
        this.#chunk     = chunk;
        this.pos        = new Vector(0, 0, 0);
        // this.tblock     = null;
        this.ticking    = null;
        this.ticker     = null;
        this._preloadFluidBuf   = null;
    }

    /**
     * If the block with the given flat index has a non-random ticker, it sets fields
     * of this class to the values of that block.
     * @returns true if success
     */
    setState(flat_pos_index: int): boolean {
        this.#chunk.chunkManager.grid.math.fromFlatChunkIndex(this.pos, flat_pos_index).addSelf(this.#chunk.coord);
        // this.tblock = this.#chunk.getBlock(this.pos);
        const tblock = this.tblock;
        if(!tblock) {
            return false
        }
        this.ticking = tblock.material.ticking
        const extra_data = tblock.extra_data
        if (!this.ticking || !extra_data || extra_data.notick) {
            return false;
        }
        this.ticker = this.#chunk.world.tickers.get(this.ticking.type);
        if(!this.ticker) {
            console.error(`Invalid ticking type: ${this.ticking.type}`);
            return false;
        }
        return true;
    }

    get tblock(): TBlock {
        return this.#chunk.getBlock(this.pos, null, null, this.tmpTBlock);
    }

}

// TickingBlockManager
export class TickingBlockManager {

    private static tmpDeleteVec = new Vector()

    #chunk: ServerChunk
    blockFlatIndices = new Set<int>();
    private tmp_check_pos = new Vector(0, 0, 0);
    private tmpTickingBlock: TickingBlock;
    private ignore_coords = new VectorCollector<any>();

    constructor(chunk: ServerChunk) {
        this.#chunk = chunk;
        this.tmpTickingBlock = new TickingBlock(chunk);
    }

    get size(): int { return this.blockFlatIndices.size }

    get chunk(): ServerChunk {
        return this.#chunk;
    }

    init(tickers: TScannedTickers): void {
        if (this.#chunk.load_state !== CHUNK_STATE.LOADING_BLOCKS) {
            throw new Error()
        }
        for(const flatIndex of tickers.tickerFlatIndices) {
            this.blockFlatIndices.add(flatIndex)
        }
    }

    // addTickingBlock
    add(pos_world: Vector): void {
        const pos_index = this.#chunk.chunkManager.grid.math.getFlatIndexInChunk(pos_world)
        this.blockFlatIndices.add(pos_index);
        const chunk = this.#chunk
        if (chunk.load_state === CHUNK_STATE.READY) {
            chunk.world.chunks.addTickingChunk(chunk.addr)
        }
    }

    // deleteTickingBlock
    delete(pos_world: IVector): void {
        const vec = TickingBlockManager.tmpDeleteVec.copyFrom(pos_world);
        const pos_index = this.#chunk.chunkManager.grid.math.getFlatIndexInChunk(vec);
        this.blockFlatIndices.delete(pos_index);
        if(this.blockFlatIndices.size == 0) {
            this.#chunk.world.chunks.removeTickingChunk(this.#chunk.addr);
        }
    }

    // tick
    tick(tick_number : int) {

        const world             = this.#chunk.world;
        const updated_blocks    = [];
        const check_pos         = this.tmp_check_pos.setScalar(0, 0, 0);
        const v                 = this.tmpTickingBlock;
        this.ignore_coords.clear()

        //
        for(const pos_index of this.blockFlatIndices) {
            if(!v.setState(pos_index)) {
                this.delete(v.pos);
                continue;
            }
            const upd_blocks = v.ticker.call(this, tick_number + pos_index, world, this.#chunk, v, check_pos, this.ignore_coords);
            TickerHelpers.pushBlockUpdates(updated_blocks, upd_blocks);
        }
        world.addUpdatedBlocksActions(updated_blocks);
    }

    *tickingBlocks(): IterableIterator<TickingBlock> {
        if (this.chunk.load_state !== CHUNK_STATE.READY) {
            return
        }
        const v = this.tmpTickingBlock
        for(const pos_index of this.blockFlatIndices) {
            if(!v.setState(pos_index)) {
                this.delete(v.pos)
                continue
            }
            yield v
        }
    }
}

let global_uniqId = 0;

// Server chunk
export class ServerChunk {

    world:                              ServerWorld;
    chunkManager:                       ServerChunkManager;
    size:                               Vector;
    addr:                               Vector;
    coord:                              Vector;
    uniqId:                             number;
    modify_list:                        ServerModifyList            = {};
    connections:                        Map<int, ServerPlayer>      = new Map(); // players by user_id
    preq:                               Map<any, any>               = new Map();
    /** Мобы в чанке. Только {@link Mob.moveToChunk} может менять это поле, совместно с {@link Mob.inChunk}. */
    mobs:                               Map<int, Mob>               = new Map();
    drop_items:                         Map<string, DropItem>       = new Map();
    randomTickingBlockCount:            int                         = 0;
    dataChunk:                          any                         = null;
    fluid:                              any                         = null;
    blocksUpdatedByListeners:           any[]                       = [];
    safeTeleportMarker:                 number                      = 0;
    spiralMarker:                       number                      = 0;
    options:                            {}                          = {};
    tblocks:                            TypedBlocks3;
    ticking_blocks:                     TickingBlockManager;
    mobGenerator:                       MobGenerator;
    delayedCalls:                       DelayedCalls;
    dbActor:                            ChunkDBActor;
    /**
     * When unloading process has started
     */
    unloadingStartedTime:               number                      = null; // to determine when to dispose it
    /** true если в выгруженным чанке есть мобы или предметы, которые нужно сохранить в БД */
    unloadedObjectsDirty:               boolean                     = false;
    //
    pendingWorldActions:                WorldAction[] | null        = null; // World actions targeting this chunk while it was loading. Execute them as soon as it's ready.
    chunkRecord:                        ChunkRecord | null          = null;
    scanId:                             number                      = -1;
    light:                              ChunkLight;
    load_state:                         CHUNK_STATE;
    _preloadFluidBuf:                   any;
    _random_tick_actions:               any;
    waitingToUnloadWater:               boolean;
    waitingToUnloadWorldTransaction:    boolean;

    static SCAN_ID = 0;

    constructor(world : ServerWorld, addr : Vector) {
        this.world                      = world;
        this.chunkManager               = world.chunks;
        this.size                       = new Vector(world.info.tech_info.chunk_size)
        this.addr                       = new Vector(addr);
        this.coord                      = this.addr.mul(this.size);
        this.uniqId                     = ++global_uniqId;
        this.ticking_blocks             = new TickingBlockManager(this);
        // World mobs generator
        if(world.getGeneratorOptions('auto_generate_mobs', false)) {
            this.mobGenerator = new MobGenerator(this);
        }
        //
        this.setState(CHUNK_STATE.NEW);
        this.delayedCalls               = new DelayedCalls(world.blockCallees);
        this.dbActor                    = world.dbActor.getOrCreateChunkActor(this);
        this.light                      = new ChunkLight(this);
    }

    isReady() : boolean {
        return this.load_state === CHUNK_STATE.READY;
    }

    get addrHash() : string { // maybe replace it with a computed string, if it's used often
        return this.addr.toHash();
    }

    get maxBlockX() : int {
        return this.coord.x + (this.size.x - 1);
    }

    get maxBlockY() : int {
        return this.coord.y + (this.size.y - 1);
    }

    get maxBlockZ() : int {
        return this.coord.z + (this.size.z - 1);
    }

    // Set chunk init state
    setState(state_id : CHUNK_STATE) {
        const old_state = this.load_state
        this.load_state = state_id;
        const chunkManager = this.getChunkManager();
        if (chunkManager) {
            chunkManager.chunkStateChanged(this, old_state, state_id);
        }
    }

    /**
     * If the last action addded to {@link pendingWorldActions} was added for {@link originalActions},
     * then returns it. Othwerwise it adds and returns a new pending {@link WorldAction} based on
     * {@link originalActions} and remembers {@link actor} in it.
     */
    getOrCreatePendingAction(actor, originalActions) {
        this.pendingWorldActions = this.pendingWorldActions ?? []
        const lastPendingActions = this.pendingWorldActions[1]
        if (lastPendingActions?.original === originalActions) {
            return lastPendingActions
        }
        const actions = originalActions.createSimilarEmpty()
        actions.original = originalActions
        actions.actor = actor
        this.pendingWorldActions.push(actions)
        return actions
    }

    // generateMobs...
    generateMobs() {
        // Generate mobs
        if(this.mobGenerator) {
            this.mobGenerator.generate();
            this.mobGenerator = null;
        }
    }

    // Load state from DB
    load() {
        if(this.load_state > CHUNK_STATE.NEW) {
            return;
        }
        this.setState(CHUNK_STATE.LOADING_DATA);
        //
        const afterLoad = ([ml, fluid]: [ServerModifyList, any]) => {
            this.modify_list = ml;
            if (this.load_state >= CHUNK_STATE.UNLOADING) {
                return;
            }
            this.setState(CHUNK_STATE.LOADING_BLOCKS);
            // Send requet to worker for create blocks structure
            this.world.chunks.postWorkerMessage(['createChunk',
                [
                    {
                        update:         true,
                        addr:           this.addr,
                        uniqId:         this.uniqId,
                        modify_list:    ml
                    }
                ]
            ]);
            // Разошлем чанк игрокам, которые его запрашивали
            this._preloadFluidBuf = fluid;
            if(this.preq.size > 0) {
                this.sendToPlayers(this.preq.keys());
                this.preq.clear();
            }
        };
        Promise.all([
            this.dbActor.loadChunkModifiers(),
            this.world.db.fluid.queuedGetChunkFluid(this.addr)
        ]).then(afterLoad);
    }

    // Returns true if the chunk has any data that needs to be sent to a client except blocks
    hasOtherData() {
        return this.mobs.size || this.drop_items.size;
    }

    // Add player connection
    addPlayer(player : ServerPlayer) {
        this.connections.set(player.session.user_id, player);
    }

    // Добавление игрока, которому после прогрузки чанка нужно будет его отправить
    addPlayerLoadRequest(player : ServerPlayer) {
        if(this.load_state < CHUNK_STATE.LOADING_BLOCKS) {
            return this.preq.set(player.session.user_id, player);
        }
        this.sendToPlayers(player);
        if(this.load_state > CHUNK_STATE.LOADING_MOBS) {
            this.sendMobs(player)
            this.sendDropItems(player);
        }
    }

    /**
     * Remove player from chunk
     */
    removePlayer(player : ServerPlayer) {
        if(this.connections.has(player.session.user_id)) {
            this.connections.delete(player.session.user_id);
            // Unload mobs for player
            // @todo перенести выгрузку мобов на сторону игрока, пусть сам их выгружает, в момент выгрузки чанков
            this.sendMobsDelete(player)
            if(this.drop_items.size > 0) {
                const packets = [{
                    name: ServerClient.CMD_DROP_ITEM_DELETED,
                    data: Array.from(this.drop_items.keys())
                }];
                this.world.sendSelected(packets, player);
            }
        }
        if(this.shouldUnload()) {
            // помечает чанк невалидным, т.к. его больше не видит ни один из игроков
            // в следующем тике мира, он будет выгружен
            this.world.chunks.invalidate(this);
        }
    }

    // Add drop item
    addDropItem(drop_item : DropItem) {
        if (drop_item.inChunk) {
            throw new Error('drop_item.inChunk');
        }
        drop_item.inChunk = this;
        this.drop_items.set(drop_item.entity_id, drop_item);
        let packets = [{
            name: ServerClient.CMD_DROP_ITEM_ADDED,
            data: [drop_item.getItemFullPacket()]
        }];
        try {
            this.sendAll(packets);
        } catch(e) {
            throw e;
        }
    }

    // Send chunk for players
    sendToPlayers(player_ids : Iterable<int> | ServerPlayer): void {
        // @CmdChunkState
        const name = ServerClient.CMD_CHUNK_LOADED;

        const fluidBuf = this.fluid ? this.fluid.saveDbBuffer() : this._preloadFluidBuf;
        const data = {addr: this.addr,
            modify_list: {} as any,
            // TODO: proper compression for fluid
            fluid: fluidBuf ? Buffer.from(fluidBuf).toString('base64') : null
        };
        const ml = this.modify_list;
        if(!ml.compressed && ml.obj) {
            this.compressModifyList();
        }
        if(ml.compressed) {
            data.modify_list.compressed = ml.compressed.toString('base64');
        } else {
            // Old code: "else" branch executes only if (ml.obj == null), so we might as well not assign it.
            // We shouldn't send it in any case, because it contains private modifiers.

            // data.modify_list.obj = ml.obj;
        }
        return this.world.sendSelected([{name, data}], player_ids);
    }

    // Compress modify list
    compressModifyList() {
        const ml = this.modify_list;
        if(ml.obj) {
            const compressed = compressWorldModifyChunk(ml.obj, true);
            ml.compressed = Buffer.from(compressed.public);
            ml.private_compressed = compressed.private ? Buffer.from(compressed.private) : null;
        }
    }

    /** Посылает {@link ServerClient.CMD_MOB_ADD} указанным игрокам, или всем игрокам, соединенным с чанком */
    sendMobs(players?: Iterable<int> | ServerPlayer): void {
        if (this.mobs.size < 1) {
            return
        }
        players ??= this.connections.keys()
        const data = []
        for(const mob of this.mobs.values()) {
            data.push(mob.exportMobModelConstructorProps());
        }
        const packet = [{
            name: ServerClient.CMD_MOB_ADD,
            data
        }]
        this.world.sendSelected(packet, players)
    }

    /** Посылает {@link ServerClient.CMD_MOB_DELETE} указанным игрокам, или всем игрокам, соединенным с чанком */
    sendMobsDelete(players?: Iterable<int> | ServerPlayer): void {
        if (this.mobs.size === 0) {
            return
        }
        players ??= this.connections.keys()
        const packet = [{
            name: ServerClient.CMD_MOB_DELETE,
            data: Array.from(this.mobs.keys())
        }]
        this.world.sendSelected(packet, players)
    }

    sendFluid(buf) {
        const packets = [{
            name: ServerClient.CMD_FLUID_UPDATE,
            data: {
                addr: this.addr,
                buf: Buffer.from(buf).toString('base64')
            }
        }];
        this.sendAll(packets, []);
    }

    /** Creates a packet describing fluid at world position {@link worldPos} */
    createFluidDeltaPacketAt(worldPos: IVector): INetworkMessage {
        const buf = FluidChunkQueue.packAsDelta(worldPos, this.fluid)
        return {
            name: ServerClient.CMD_FLUID_DELTA,
            data: {
                addr: this.addr,
                buf: Buffer.from(buf).toString('base64')
            }
        }
    }

    sendFluidDelta(buf: Uint8Array): void {
        const packets = [{
            name: ServerClient.CMD_FLUID_DELTA,
            data: {
                addr: this.addr,
                buf: Buffer.from(buf).toString('base64')
            }
        }];
        this.sendAll(packets, []);
    }

    /** Посылает {@link ServerClient.CMD_DROP_ITEM_ADDED} указанным игрокам, или всем игрокам, соединенным с чанком */
    sendDropItems(player_user_ids?: Iterable<int> | ServerPlayer): void {
        // Send all drop items in this chunk
        if (this.drop_items.size < 1) {
            return;
        }
        player_user_ids ??= this.connections.keys()
        let packets = [{
            name: ServerClient.CMD_DROP_ITEM_ADDED,
            data: []
        }];
        for(const drop_item of this.drop_items.values()) {
            packets[0].data.push(drop_item.getItemFullPacket());
        }
        this.world.sendSelected(packets, player_user_ids);
    }

    // onBlocksGenerated ... Webworker callback method
    onBlocksGenerated(args: TChunkWorkerMessageBlocksGenerated): void {
        const chunkManager = this.getChunkManager();
        if (!chunkManager) {
            return;
        }
        if (args.uniqId !== this.uniqId) {
            //TODO cover it with a test
            return;
        }
        /* Some debug code, probably remove it
        if(this.addr.equal(new Vector(-10,0,-1))) {
            let ids = [];
            for(let i = 0; i < args.tblocks.id.length; i++) {
                let id = args.tblocks.id[i];
                if(id > 0) ids.push(id);
            }
        }
        */
        this.tblocks = newTypedBlocks(this.coord, chunkManager.dataWorld.grid);
        this.tblocks.chunk = this;
        this.tblocks.light = this.light;
        chunkManager.dataWorld.addChunk(this);
        if(args.tblocks) {
            this.tblocks.restoreState(args.tblocks);
        }
        if (args.tickers) {
            this.randomTickingBlockCount = args.tickers.randomTickersCount
            this.ticking_blocks.init(args.tickers)
        }
        if(this._preloadFluidBuf) {
            // now its stored in fluid facet
            this.fluid.loadDbBuffer(this._preloadFluidBuf, true);
            this._preloadFluidBuf = null;
        }
        this.light.init(args.dayLightDefaultValue)
        // noinspection JSIgnoredPromiseFromCall
        this.loadMobs();
        this.onBlocksGeneratedOrRestored();
    }

    restoreUnloaded() {
        // restore unloaded mobs and items
        for(const item of this.drop_items.values()) {
            item.restoreUnloaded()
        }
        for(const mob of this.mobs.values()) {
            mob.onAddedOrRestored()
        }
        this.unloadedObjectsDirty = false;

        this.chunkManager.dataWorld.addChunk(this, true);
        this.onBlocksGeneratedOrRestored();
        this.onMobsLoadedOrRestored();
    }

    private onBlocksGeneratedOrRestored(): void {
        const chunkManager = this.getChunkManager();
        if (!chunkManager) {
            return;
        }
        chunkManager.dataWorld.syncOuter(this);
        // fluid
        this.fluid.queue.init();
    }

    /**
     * @returns a promise, but it doesn't matter, and the caller don't have to process it.
     *  This method calls {@link onMobsLoadedOrRestored} later asynchronously,
     *  which changes the chunk state, sends data to the clients, etc.
     */
    async loadMobs() {
        this.setState(CHUNK_STATE.LOADING_MOBS);

        // load various data in parallel
        const chunkRecordMobsPromise = this.world.db.chunks.getChunkOfChunk(this).then( async chunkRecord => {
            const mobs = this.world.mobs
            this.chunkRecord = chunkRecord;
            this.chunkRecord.chunk = this; // some fields are taken directly from the chunk when inserting/updateing chunkRecord
            // now we can load things that required chunkRecord
            if (this.chunkRecord.delayed_calls) {
                this.delayedCalls.deserialize(this.chunkRecord.delayed_calls);
                delete this.chunkRecord.delayed_calls;
            }
            const loadedMobs = await this.world.db.mobs.loadInChunk(this);
            for(const [mob, driving_data] of loadedMobs) {
                if (mobs.get(mob.id) || mobs.inactiveById.has(mob.id) || mobs.inactiveByIdBeingWritten?.has(mob.id)) {
                    // Возможно, этот моб уже существует в мире. Например, он вышел из своего чанка в этот чанк
                    // (еще не загруженый). Если так - он сам присоединится к нужному чанку, не создавать копию.
                    // Не уверен возможно ли что он деактивирован, но на всякий случай проверим и это.
                    continue
                }
                mob.moveToChunk(this, false) // не высылать апдейт - потом чанк вышлет его для всех мобов вместе
                mob.onAddedOrRestored()
                this.world.drivingManager.onParticipantLoaded(mob, driving_data)
            }
        });
        this.drop_items = await this.world.db.loadDropItems(this.coord, this.size);
        await chunkRecordMobsPromise;

        this.onMobsLoadedOrRestored();
    }

    private onMobsLoadedOrRestored() {
        const chunkManager = this.getChunkManager();
        // Разошлем мобов всем игрокам, которые "контроллируют" данный чанк
        if(this.connections.size > 0) {
            this.sendMobs()
            this.sendDropItems()
        }
        // If some delayed calls have been loaded
        if (this.delayedCalls.length) {
            chunkManager.chunks_with_delayed_calls.add(this);
        }
        this.setState(CHUNK_STATE.READY);
        // apply pending world actions (they were created while the chunk was loading)
        if (this.pendingWorldActions) {
            // Push them to the beginning of the actions queue, preserving their order of creation.
            // They must be pushed to the beginning because:
            // 1. They are older than any existing actoion in the queue.
            // 2. To ensure that they will be processed before the chunk unloads again even if the queus is so long
            //   that it won't be processed completely in one tick.
            for(let i = this.pendingWorldActions.length - 1; i>= 0; i--) {
                const action = this.pendingWorldActions[i];
                this.world.actions_queue.addFirst(action.actor, action);
            }
            this.pendingWorldActions = null;
        }
        if (this.shouldUnload()) {
            // TODO : wait a bit, dont unload yet?
            chunkManager.invalidate(this);
        }
    }

    shouldUnload() : boolean {
        if (this.connections.size + this.safeTeleportMarker + this.spiralMarker > 0) {
            return false
        }
        if (this.load_state === CHUNK_STATE.LOADING_MOBS
            || this.load_state >= CHUNK_STATE.UNLOADING) {
            return false;
        }
        return true;
    }



    // Return block key
    getBlockKey(pos) {
        return new Vector(pos).toHash();
    }

    //
    sendAll(packets : INetworkMessage[], except_players? : number[]) {
        this.world.sendSelected(packets, this.connections.keys(), except_players);
    }

    getChunkManager() : ServerChunkManager {
        return this.chunkManager;
    }

    // It's slightly faster than getBlock().
    getMaterial(pos : Vector | number, y? : number, z? : number, fromOtherChunks = false) {
        if(this.load_state !== CHUNK_STATE.READY) {
            return this.getChunkManager().DUMMY.material;
        }

        if (typeof pos == 'number') {
            pos = tmp_posVector.set(pos, y, z);
        } else {
            // We expect (typeof pos == 'object') here.
            pos = tmp_posVector.initFrom(pos);
        }
        pos.flooredSelf().subSelf(this.coord);

        if (pos.x < 0 || pos.y < 0 || pos.z < 0 || pos.x >= this.size.x || pos.y >= this.size.y || pos.z >= this.size.z) {
            if (fromOtherChunks) {
                pos.addSelf(this.coord);
                const otherChunk = this.world.chunks.getReadyByPos(pos);
                if (otherChunk) {
                    // this recursion it doesn't affect tmp_posVector
                    return otherChunk.getMaterial(pos);
                }
            }
            return this.getChunkManager().DUMMY.material;
        }
        return this.tblocks.getMaterial(pos);
    }

    // Get the type of the block at the specified position.
    // Mostly for neatness, since accessing the array
    // directly is easier and faster.
    // If the argument after the coordiantes (y or fromOtherChunks) is true,
    // it can return blocks from chunks outside its boundary.
    getBlock(pos_ : number | IVector, y? : number, z? : number, resultBlock: TBlock | null = null, fromOtherChunks: boolean = false) {
        if(this.load_state !== CHUNK_STATE.READY) {
            return this.getChunkManager().DUMMY;
        }

        let pos: Vector
        if (typeof pos_ == 'number') {
            pos = tmp_posVector.set(pos_, y, z);
        } else {
            // We expect (typeof pos == 'object') here.
            pos = tmp_posVector.copyFrom(pos_);
        }
        pos.flooredSelf().subSelf(this.coord);

        if(pos.x < 0 || pos.y < 0 || pos.z < 0 || pos.x >= this.size.x || pos.y >= this.size.y || pos.z >= this.size.z) {
            if (fromOtherChunks) {
                pos.addSelf(this.coord);
                const otherChunk = this.world.chunks.getReadyByPos(pos) as ServerChunk;
                if (otherChunk) {
                    // this recursion it doesn't affect tmp_posVector
                    return otherChunk.getBlock(pos, null, null, resultBlock);
                }
            }
            return this.getChunkManager().DUMMY;
        }
        return this.tblocks.get(pos.clone(), resultBlock);
    }

    // getBlockAsItem
    getBlockAsItem(pos : Vector | number, y? : number, z? : number) {
        const block = this.getBlock(pos, y, z);
        return this.world.block_manager.convertBlockToDBItem(block);
    }

    getFluidValue(pos : Vector | number, y? : number, z? : number) {
        if (typeof pos == 'object') {
            y = pos.y;
            z = pos.z;
            pos = pos.x;
        }
        return this.fluid.uint8View[FLUID_STRIDE * this.dataChunk.indexByWorld(pos, y, z) + OFFSET_FLUID];
    }

    isLava(pos : Vector | number, y? : number, z? : number) {
        return (this.getFluidValue(pos, y, z) & FLUID_TYPE_MASK) === FLUID_LAVA_ID;
    }

    isWater(pos : Vector | number, y? : number, z? : number) {
        return (this.getFluidValue(pos, y, z) & FLUID_TYPE_MASK) === FLUID_WATER_ID;
    }

    isFluid(pos : Vector | number, y? : number, z? : number) {
        return (this.getFluidValue(pos, y, z) & FLUID_TYPE_MASK) !== 0;
    }

    checkDestroyNearUncertainStones(item_pos : Vector, item : IBlockItem, previous_item : IBlockItem, radius : int) {

        let actions : WorldAction;
        const world = this.world;
        const bm = world.block_manager

        //
        const addBlock = (pos : Vector, item : IBlockItem) => {
            if(!actions) actions = new WorldAction(null, null, false, false);
            const action_id = ServerClient.BLOCK_ACTION_REPLACE
            actions.addBlocks([{pos, item, action_id}])
        }

        //
        const check = (tblock : TBlock, neighbour, previous_neighbour, min_solid_count : int = 5) => {
            const require_support = tblock.material.support_style || tblock.material.style_name;
            if(require_support == 'uncertain_stone') {
                // определяем неопределенный камень
                const item = {
                    id: bm.STONE.id
                }
                // количество сплошных блоков вокруг текущего блока
                const solid_neightbours_count = tblock.tb.blockSolidNeighboursCount(tblock.vec.x, tblock.vec.y, tblock.vec.z)
                // если блок прикрывал сплошной блок
                if(solid_neightbours_count == 6 || (bm.isSolidID(previous_neighbour.id) && solid_neightbours_count == min_solid_count)) {
                    // 1. Если сейчас вокруг блока 5 сплошных блоков, а убрали сплошной,
                    //    значит текущий блок только что был "вскрыт" и его можно превратить в руду)
                    // 2. Если вокруг блока 6 сплошных, значит убрали блок в радиусе 2 блока от текущего и также нужно его определить сейчас,
                    //    чтобы при дальнейшем продолжении раскопок в данном направлении блоки уже были определенными и не "мерцали"
                    item.id = world.ore_generator.generate(tblock.posworld, bm.STONE.id)
                }
                addBlock(tblock.posworld.clone(), item)
            }
        }

        //
        const checked_poses = new VectorCollector()
        function process(pos : Vector, iters : int, previous_item : IBlockItem, min_solid_count : int) {
            const tblock = world.getBlock(pos);
            if(tblock?.getNeighbours) {
                const cache = Array.from({length: 6}, _ => new TBlock(null, new Vector(0, 0, 0)));
                const neighbours = tblock.getNeighbours(world, cache);
                for(let side in neighbours) {
                    if(side == 'pcnt') continue;
                    const nb = neighbours[side];
                    if(nb.id > 0) {
                        if(!checked_poses.has(nb.posworld)) {
                            checked_poses.set(nb.posworld, true)
                            check(nb, tblock, previous_item, min_solid_count);
                        }
                    }
                    if(iters > 1) {
                        process(nb.posworld, iters - 1, nb, 6)
                    }
                }
            }
        }

        process(item_pos, radius, previous_item, 5)

        //
        if(actions) {
            world.actions_queue.add(null, actions);
        }

    }

    // On block set
    async onBlockSet(item_pos : Vector, item, previous_item : IBlockItem) {

        const bm = this.world.block_manager
        const tblock = this.world.getBlock(item_pos);

        if(tblock) {
            const cache = Array.from({length: 6}, _ => new TBlock(null, new Vector(0, 0, 0)));
            const neighbours = tblock.getNeighbours(this.world, cache);
            for(let side in neighbours) {
                const nb = neighbours[side];
                if(nb.id > 0) {
                    this.onNeighbourChanged(nb, tblock, previous_item);
                }
            }
        }

        switch(item.id) {
            // 1. Make snow golem
            case bm.LIT_PUMPKIN.id: {
                const pos = item_pos.clone();
                pos.y--;
                let under1 = this.world.getBlock(pos.clone());
                pos.y--;
                let under2 = this.world.getBlock(pos.clone());
                if(under1?.id == bm.POWDER_SNOW.id && under2?.id == bm.POWDER_SNOW.id) {
                    pos.addSelf(new Vector(.5, 0, .5));
                    const params: MobSpawnParams = {
                        skin:       {model_name: MOB_TYPE.SNOW_GOLEM, texture_name: DEFAULT_MOB_TEXTURE_NAME},
                        pos:        pos.clone(),
                        pos_spawn:  pos.clone(),
                        rotate:     item.rotate ? new Vector(item.rotate).toAngles() : null
                    }
                    this.world.mobs.create(params);
                    const actions = new WorldAction(null, this.world, false, false);
                    actions.addBlocks([
                        {pos: item_pos, item: {id: bm.AIR.id}, destroy_block: {id: item.id}, action_id: ServerClient.BLOCK_ACTION_DESTROY},
                        {pos: under1.posworld, item: {id: bm.AIR.id}, destroy_block: {id: under1?.id}, action_id: ServerClient.BLOCK_ACTION_DESTROY},
                        {pos: under2.posworld, item: {id: bm.AIR.id}, destroy_block: {id: under2?.id}, action_id: ServerClient.BLOCK_ACTION_DESTROY}
                    ])
                    this.world.actions_queue.add(null, actions);
                }
                break;
            }
        }

    }

    onNeighbourChanged(tblock : TBlock, neighbour : TBlock, previous_neighbour) {

        const world = this.world;
        const bm = world.block_manager

        // метод работы со сталактитами и сталагмитами
        const changePointedDripstone = () => {
            const up = tblock?.extra_data?.up;
            const block = this.getBlock(neighbour.posworld.offset(0, up ? 2 : -2, 0), null, null, null, true);
            if (block?.id == bm.POINTED_DRIPSTONE.id && block?.extra_data?.up == up) {
                const actions = new WorldAction();
                actions.addBlocks([{
                    pos: block.posworld.clone(),
                    item: {
                        id: block.id,
                        extra_data: {
                            up: up
                        }
                    },
                    action_id: ServerClient.BLOCK_ACTION_MODIFY
                }]);
                world.actions_queue.add(null, actions);
            }
        };

        //
        function createDrop(tblock : TBlock, generate_destroy : boolean = false) {
            const pos = tblock.posworld;
            const actions = new WorldAction(null, world, false, true);
            //
            if(generate_destroy) {
                actions.addBlocks([{pos: pos.clone(), item: {id: bm.AIR.id}, destroy_block: {id: tblock.id}, action_id: ServerClient.BLOCK_ACTION_DESTROY}]);
            } else {
                actions.addBlocks([{pos: pos.clone(), item: {id: bm.AIR.id}, action_id: ServerClient.BLOCK_ACTION_REPLACE}]);
            }
            //
            if (!tblock.material.tags.includes('no_drop')) {
                dropBlock(null, tblock, actions, true)
            }
            //
            world.actions_queue.add(null, actions);
        }

        const pos = tblock.posworld;
        const rot = tblock.rotate || Vector.YP;
        const rotx = tblock.rotate?.x;
        const roty = tblock.rotate?.y;
        const neighbourPos = neighbour.posworld;
        const require_support = tblock.material.support_style || tblock.material.style_name;
        const neighbour_destroyed = neighbour.id == 0;

        // Different behavior, depending on whether the neighbor was destroyed or created
        if(neighbour_destroyed) {

            if (tblock.id == bm.SNOW.id && neighbourPos.y < pos.y) {
                return createDrop(tblock, true);
            }

            switch(require_support) {
                case 'bottom': // not a block style, but a name for a common type of support
                case 'rails':
                case 'candle':
                case 'redstone':
                case 'cactus': {
                    // only bottom
                    if(neighbourPos.y < pos.y) {
                        return createDrop(tblock);
                    }
                    break;
                }
                case 'chorus': {
                    // only bottom
                    if(neighbourPos.y <= pos.y) {
                        return createDrop(tblock);
                    }
                    break;
                }
                case 'lantern': {
                    // top and bottom
                    if(neighbourPos.y < pos.y && roty == 1) {
                        return createDrop(tblock);
                    } else if(neighbourPos.y > pos.y && roty == -1) {
                        return createDrop(tblock);
                    }
                    break;
                }
                case 'sign':
                case 'torch': {
                    // nesw + bottom
                    let drop = false;
                    if (roty == 0) {
                        switch (rotx) {
                            case 0: drop = neighbourPos.z < pos.z; break;
                            case 1: drop = neighbourPos.x > pos.x; break;
                            case 2: drop = neighbourPos.z > pos.z; break;
                            case 3: drop = neighbourPos.x < pos.x; break;
                        }
                    } else if (roty == 1) {
                        drop = neighbourPos.y < pos.y;
                    }
                    if(drop) {
                        return createDrop(tblock);
                    }
                    break;
                }
                case 'item_frame': {
                    // 6 sides
                    let drop = false;
                    // console.log(neighbourPos.z > pos.z, SIX_VECS.north, rot);
                    if(neighbourPos.z > pos.z && SIX_VECS.south.equal(rot)) {
                        drop = true;
                    } else if(neighbourPos.z < pos.z && SIX_VECS.north.equal(rot)) {
                        drop = true;
                    } else if(neighbourPos.x > pos.x && SIX_VECS.west.equal(rot)) {
                        drop = true;
                    } else if(neighbourPos.x < pos.x && SIX_VECS.east.equal(rot)) {
                        drop = true;
                    } else if(neighbourPos.y > pos.y && rot.y == -1) {
                        drop = true;
                    } else if(neighbourPos.y < pos.y && rot.y == 1) {
                        drop = true;
                    }
                    if(drop) {
                        return createDrop(tblock);
                    }
                    break;
                }
                case 'chest': {
                    // if a chest half is missing the other half, convert it to a normal chest
                    if (neighbourPos.y === pos.y && // a fast redundant check to eliminate 2 out of 6 slower checks
                        ChestHelpers.getSecondHalfPos(tblock)?.equal(neighbourPos)
                    ) {
                        const newTblock = tblock.clonePOJO();
                        delete newTblock.extra_data.type;
                        const actions = new WorldAction();
                        actions.addBlocks([
                            {
                                pos: pos.clone(),
                                item: newTblock,
                                action_id: ServerClient.BLOCK_ACTION_MODIFY
                            }
                        ]);
                        world.actions_queue.add(null, actions);
                    }
                    break;
                }
                case 'painting':
                case 'ladder': {
                    if (neighbourPos.y === pos.y) {
                        // 6 sides
                        let drop = false;
                        if(neighbourPos.z > pos.z && (rot.x == DIRECTION.SOUTH || SIX_VECS.south.equal(rot))) {
                            drop = true;
                        } else if(neighbourPos.z < pos.z && (rot.x == DIRECTION.NORTH || SIX_VECS.north.equal(rot))) {
                            drop = true;
                        } else if(neighbourPos.x > pos.x && (rot.x == DIRECTION.WEST || SIX_VECS.west.equal(rot))) {
                            drop = true;
                        } else if(neighbourPos.x < pos.x && (rot.x == DIRECTION.EAST || SIX_VECS.east.equal(rot))) {
                            drop = true;
                        }
                        if(drop) {
                            return createDrop(tblock);
                        }
                    }
                    break;
                }
                case 'cover': {
                    let drop = false;
                    if(tblock.extra_data) {
                        const removeCoverSide = (side_name : string) => {
                            if(tblock.extra_data[side_name]) {
                                const new_extra_data = {...tblock.extra_data}
                                delete(new_extra_data[side_name])
                                const existing_faces = Object.keys(new_extra_data).filter(value => COVER_STYLE_SIDES.includes(value));
                                if(existing_faces.length == 0) {
                                    drop = true;
                                } else {
                                    const newTblock = tblock.clonePOJO();
                                    newTblock.extra_data = new_extra_data;
                                    const actions = new WorldAction();
                                    actions.addBlocks([
                                        {
                                            pos: pos.clone(),
                                            item: newTblock,
                                            action_id: ServerClient.BLOCK_ACTION_MODIFY
                                        }
                                    ]);
                                    world.actions_queue.add(null, actions);
                                }
                            }
                        }
                        //
                        if(neighbourPos.z > pos.z) {
                            removeCoverSide('south')
                        } else if(neighbourPos.z < pos.z) {
                            removeCoverSide('north')
                        } else if(neighbourPos.x > pos.x) {
                            removeCoverSide('west')
                        } else if(neighbourPos.x < pos.x) {
                            removeCoverSide('east')
                        } else if(neighbourPos.y < pos.y) {
                            removeCoverSide('up')
                        } else if(neighbourPos.y > pos.y) {
                            removeCoverSide('down')
                        }
                    } else {
                        drop = true;
                    }
                    //
                    if(drop) {
                        return createDrop(tblock);
                    }
                    break;
                }
                case 'planting': {
                    if(neighbourPos.y < pos.y) {
                        return createDrop(tblock, true);
                    }
                    break;
                }
                case 'pointed_dripstone': {
                    changePointedDripstone();
                    break;
                }
            }

        } else {

            // Neighbour block created

            switch(require_support) {
                case 'cactus': {
                    // nesw only
                    if(neighbourPos.y == pos.y && !(neighbour.material.transparent && neighbour.material.light_power)) {
                        return createDrop(tblock);
                    }
                    break;
                }
                case 'chest': {
                    const chestId = bm.CHEST.id;
                    // check if we can combine two halves into a double chest
                    if (neighbourPos.y !== pos.y ||
                        tblock.material.id !== chestId ||
                        tblock.extra_data?.type ||
                        neighbour.material.id !== chestId ||
                        neighbour.extra_data?.type
                    ) {
                        break;
                    }
                    const dir = bm.getCardinalDirection(rot);
                    if (dir !== bm.getCardinalDirection(neighbour.rotate)) {
                        break;
                    }
                    var newType = null;
                    var newNeighbourType = null;
                    const dxz = RIGHT_NEIGBOUR_BY_DIRECTION[dir];
                    const expectedNeighbourPos = pos.clone().addSelf(dxz);
                    if (expectedNeighbourPos.equal(neighbourPos)) {
                        newType = 'right';
                        newNeighbourType = 'left';
                        // a fix for a chest inserted btween two - the one on the left doesn't attempt to transform
                        const farNeighbourPos = expectedNeighbourPos.clone().addSelf(dxz);
                        var farNeighbour = this.getBlock(farNeighbourPos, null, null, null, true);
                        if (farNeighbour &&
                            farNeighbour.material.id === chestId &&
                            farNeighbour.extra_data?.type == null &&
                            dir === bm.getCardinalDirection(farNeighbour.rotate)
                        ) {
                            break;
                        }
                    } else {
                        expectedNeighbourPos.copyFrom(pos).subSelf(dxz);
                        if (expectedNeighbourPos.equal(neighbourPos)) {
                            newType = 'left';
                            newNeighbourType = 'right';
                        } else {
                            break;
                        }
                    }
                    const newTblock                 = tblock.clonePOJO();
                    newTblock.extra_data            = newTblock.extra_data || {};
                    newTblock.extra_data.type       = newType;
                    const newNeighbour              = neighbour.clonePOJO();
                    newNeighbour.extra_data         = newNeighbour.extra_data || {};
                    newNeighbour.extra_data.type    = newNeighbourType;
                    const actions = new WorldAction();
                    actions.addBlocks([
                        {
                            pos: pos.clone(),
                            item: newTblock,
                            action_id: ServerClient.BLOCK_ACTION_MODIFY
                        },
                        {
                            pos: neighbourPos.clone(),
                            item: newNeighbour,
                            action_id: ServerClient.BLOCK_ACTION_MODIFY
                        }
                    ]);
                    world.actions_queue.add(null, actions);
                    break;
                }
                case 'uncertain_stone': {
                    // заменяем неопределенный камень на просто камень,
                    // потому что рядом с ним поставили какой-то блок
                    const item = {
                        id: bm.STONE.id
                    }
                    const actions = new WorldAction(null, null, false, false);
                    actions.addBlocks([{
                        pos: pos.clone(),
                        item: item,
                        action_id: ServerClient.BLOCK_ACTION_REPLACE
                    }]);
                    world.actions_queue.add(null, actions);
                    break;
                }
                case 'pointed_dripstone': {
                    changePointedDripstone();
                    break;
                }
            }
        }

        return false;

    }

    // Store in modify list
    addModifiedBlock(pos : IVector, item : IBlockItem, previousId : int) {
        const ml = this.modify_list;
        const bm = this.world.block_manager
        if(!ml.obj) ml.obj = {};
        pos = Vector.vectorify(pos);
        ml.obj[this.chunkManager.grid.math.getFlatIndexInChunk(pos as Vector)] = item;
        ml.compressed = null;
        ml.private_compressed = null;
        if(item) {
            // calculate random ticked blocks
            if(bm.BLOCK_BY_ID[previousId]?.random_ticker) {
                this.randomTickingBlockCount--;
            }
            //
            if(item.id) {
                const block = bm.fromId(item.id);
                if(block.random_ticker) {
                    this.randomTickingBlockCount++;
                }
                if(block.ticking && item.extra_data && !('notick' in item.extra_data)) {
                    this.ticking_blocks.add(pos as Vector);
                }
            }
        }
    }

    // On world tick
    tick(tick_number : int) {
        if (this.load_state === CHUNK_STATE.READY) {
            this.ticking_blocks.tick(tick_number);
        }
    }

    getActions() : WorldAction {
        if(!this._random_tick_actions) {
            this._random_tick_actions = new WorldAction(null, this.world, false, false);
        }
        return this._random_tick_actions;
    }

    // Random tick
    randomTick(tick_number : int, world_light : int , check_count : int): boolean {
        const {fromFlatChunkIndex, CHUNK_SIZE} = this.chunkManager.grid.math;

        if(this.load_state !== CHUNK_STATE.READY || !this.tblocks || this.randomTickingBlockCount <= 0) {
            return false;
        }

        const block_random_tickers = this.chunkManager.block_random_tickers;

        for (let i = 0; i < check_count; i++) {
            fromFlatChunkIndex(_rnd_check_pos, Math.floor(Math.random() * CHUNK_SIZE));
            const block_id = this.tblocks.getBlockId(_rnd_check_pos.x, _rnd_check_pos.y, _rnd_check_pos.z);
            if(block_id > 0) {
                const ticker = block_random_tickers[block_id];
                if(ticker) {
                    const tblock = this.tblocks.get(_rnd_check_pos, tmpRandomTickerTBlock);
                    ticker.call(this, this.world, this.getActions(), world_light, tblock);
                }
            }
        }

        //
        const actions = this._random_tick_actions;
        if(actions && actions.blocks.list.length > 0) {
            globalThis.modByRandomTickingBlocks = (globalThis.modByRandomTickingBlocks | 0) + actions.blocks.list.length;
            this.world.actions_queue.add(null, actions);
            this._random_tick_actions = null;
        }

        return true;

    }

    addDelayedCall(calleeId, delay, args) {
        this.delayedCalls.add(calleeId, delay, args);
        // If we just aded the 1st call, we know the chunk is not in the set
        if (this.delayedCalls.length === 1) {
            this.getChunkManager().chunks_with_delayed_calls.add(this);
        }
    }

    onFluidEvent(pos, isFluidChangeAbove) {
        const that = this;
        function processResult(res, calleeId) {
            if (typeof res === 'number') {
                that.addDelayedCall(calleeId, res, [pos.clone()]);
            } else {
                TickerHelpers.pushBlockUpdates(that.blocksUpdatedByListeners, res);
            }
        }

        const tblock = this.getBlock(pos, null, null, tmp_onFluidEvent_TBlock);
        const fluidY = isFluidChangeAbove ? pos.y + 1 : pos.y;
        const fluidValue = this.getFluidValue(pos.x, fluidY, pos.z);

        if (isFluidChangeAbove) {
            var listeners = this.world.blockListeners.fluidAboveChangeListeners[tblock.id];
            if (listeners) {
                for(let listener of listeners) {
                    var res = listener.onFluidAboveChange(this, tblock, fluidValue, true);
                    processResult(res, listener.onFluidAboveChangeCalleeId);
                }
            }
            if ((fluidValue & FLUID_TYPE_MASK) === 0) {
                listeners = this.world.blockListeners.fluidAboveRemoveListeners[tblock.id];
                if (listeners) {
                    for(let listener of listeners) {
                        var res = listener.onFluidAboveRemove(this, tblock, true);
                        processResult(res, listener.onFluidAboveRemoveCalleeId);
                    }
                }
            }
        } else {
            var listeners = this.world.blockListeners.fluidChangeListeners[tblock.id];
            if (listeners) {
                for(let listener of listeners) {
                    var res = listener.onFluidChange(this, tblock, fluidValue, true);
                    processResult(res, listener.onFluidChangeCalleeId);
                }
            }
            if ((fluidValue & FLUID_TYPE_MASK) === 0) {
                listeners = this.world.blockListeners.fluidRemoveListeners[tblock.id];
                if (listeners) {
                    for(let listener of listeners) {
                        var res = listener.onFluidRemove(this, tblock, true);
                        processResult(res, listener.onFluidRemoveCalleeId);
                    }
                }
            }
        }
    }

    applyChangesByListeners() {
        this.world.addUpdatedBlocksActions(this.blocksUpdatedByListeners);
        this.blocksUpdatedByListeners.length = 0;
    }

    executeDelayedCalls() {
        if (this.delayedCalls.length === 0) {
            return;
        }
        this.delayedCalls.execute(this);
        // If we just emptied the calls list, delete the chunk from the set
        if (this.delayedCalls.length === 0) {
            this.getChunkManager().chunks_with_delayed_calls.delete(this);
        }
        this.applyChangesByListeners();
    }

    // Before unload chunk
    onUnload() {
        const chunkManager = this.getChunkManager();
        if (!chunkManager || this.load_state !== CHUNK_STATE.READY || this.connections.size) {
            throw new Error(`!chunkManager || this.load_state !== CHUNK_STATE.READY || this.connections.size ${chunkManager} ${this.load_state}`);
        }

        this.unloadingStartedTime = performance.now();
        this.setState(CHUNK_STATE.UNLOADING);
        // Instead of awaiting Promise.all(), we use the flags showing what sill needs to be unloaded.
        // It solves the problem of old unloading promise still pending when the chunk is restored and unloaded again.
        this.waitingToUnloadWater = true;
        this.waitingToUnloadWorldTransaction = true;

        // unload water
        if (this.dataChunk) {
            chunkManager.world.db.fluid.flushChunk(this.tblocks.fluid).then(() => {
                this.waitingToUnloadWater = false; // modify the object from the closure, not the class field!
                this.checkUnloadingProgress();
            });
        } else {
            this.waitingToUnloadWater = false;
        }

        // === Unload everything in the world transaction ===

        // Delayed calls will be saved by dbActor, only unregister them here
        if (this.delayedCalls.length) {
            chunkManager.chunks_with_delayed_calls.delete(this);
        }
        // Unload mobs
        for(const mob of this.mobs.values()) {
            if (mob.onUnload()) {
                this.unloadedObjectsDirty = true
            }
        }
        // Unload drop items
        for(const drop_item of this.drop_items.values()) {
            if (drop_item.onUnload()) {
                this.unloadedObjectsDirty = true;
            }
        }
        if (this.dbActor.mustSaveWhenUnloading()) {
            this.world.dbActor.dirtyActors.add(this.dbActor);
            // ChunkDBActor will update this.waitingToUnloadWorldTransaction and call checkUnloadingProgress()
        } else {
            this.waitingToUnloadWorldTransaction = false;
            this.checkUnloadingProgress();
        }
    }

    checkUnloadingProgress() {
        if (this.load_state === CHUNK_STATE.UNLOADING &&
            !this.waitingToUnloadWater &&
            !this.waitingToUnloadWorldTransaction
        ) {
            this.setState(CHUNK_STATE.UNLOADED);
            this.chunkManager.chunkUnloaded(this);
        }
    }

    dispose() {
        // the chunk is already removed from world.dbActor.dirtyActors, because it wrote all its data when it unloaded
        this.setState(CHUNK_STATE.DISPOSED);
        this.light.dispose();
        this.chunkManager.chunkDisposed(this);
    }

}

const tmp_posVector         = new Vector();
const tmp_onFluidEvent_TBlock = new TBlock();