import { Mth, Vector} from './helpers.js';
import { AABB } from './core/AABB.js';
import type { World } from './world.js';

// AABBDrawable
export class AABBDrawable extends AABB {
    [key: string]: any;

    draw(render, pos, delta, do_draw) {
        if (do_draw) {
            render.debugGeom.addAABB(this,
                {colorABGR: 0xFFFFFFFF, lineWidth: .25});
        }
    }

}

export type NetworkPhysicObjectState = {
    pos         : IVector
    time        : number
    rotate ?    : Vector
    tracked ?   : boolean
    sneak ?     : int | boolean // It can be true, false, 0. It probably should be boolean.
    extra_data? : object
}

/**
 * Временные объекты, используемые при интерполяции координат.
 * Актуальные значения у объекта - {@link NetworkPhysicObject.pos}, {@link NetworkPhysicObject.yaw} и {@link NetworkPhysicObject.pitch}.
 */
const tPos = new Vector()
const tRot = new Vector()

// NetworkPhysicObject
export class NetworkPhysicObject {

    #world : World
    netBuffer           : NetworkPhysicObjectState[]
    yaw                 : float
    pitch               : float
    protected sneak     : number | boolean
    private _pos        : Vector
    private _prevPos    : Vector    // не используется, можно убрать
    protected moving    : boolean
    private _chunk_addr : Vector
    private latency     : number
    aabb                : AABBDrawable | null
    private tracked     : boolean
    extra_data?         : Dict | null
    width               : number
    height              : number

    constructor(world : World, pos: Vector, rotate: IVector) {

        this.#world         = world
        this._pos           = pos;
        this._prevPos       = new Vector(pos);

        this.moving         = false;
        this._chunk_addr    = new Vector(0, 0, 0);
        this.yaw            = rotate.z;
        this.pitch          = rotate.x;
        this.sneak          = 0;

        // Networking
        this.netBuffer = [];
        this.latency = 50;
        this.aabb = null;

        this.tracked = false;
    }

    get pos(): Vector {
        return this._pos;
    }

    get chunk_addr() {
        return this.world.chunkManager.grid.toChunkAddr(this.pos, this._chunk_addr);
    }

    get world() : World {
        return this.#world
    }

    set pos(v: IVector) {
        const {
            x, y, z
        } = this._pos;

        const dx = v.x - x;
        const dy = v.y - y;
        const dz = v.z - z;

        this._prevPos.copyFrom(this._pos);
        this._pos.copyFrom(v);

        this.moving = Math.abs(dx) + Math.abs(dz) > 0.002
    }

    get clientTime() {
        return this.world ? this.world.serverTimeWithLatency : Date.now();
    }

    applyNetState(data: NetworkPhysicObjectState = {pos: null, time: 0, rotate: null}) {
        if (data.tracked) {
            this.tracked = true;
        }
        this.netBuffer.push(data);
    }

    applyState(nextPos: IVector, nextRot?: IVector | null, sneak?: number | boolean, extra_data?: Dict): void {
        this.pos = nextPos;
        if(extra_data) {
            this.extra_data = extra_data;
        }
        if(nextRot) {
            this.yaw = nextRot.z;
            this.pitch = nextRot.x;
        }
        if (sneak != null) {
            this.sneak = sneak;
        }
    }

    processNetState(): void {
        if (this.netBuffer.length === 0) {
            return;
        }

        const correctedTime = this.clientTime;

        while (this.netBuffer.length > 1 && correctedTime > this.netBuffer[1].time) {
            this.netBuffer.shift();
        }

        if (this.netBuffer.length === 1) {
            return this.applyState(
                this.netBuffer[0].pos,
                this.netBuffer[0].rotate,
                this.netBuffer[0].sneak || 0,
                this.netBuffer[0].extra_data || null
            );
        }

        const {
            pos: prevPos,
            rotate: prevRot,
            time: prevTime,
            sneak: prevSneak = 0,
            extra_data: prevExtraData = null,
        } = this.netBuffer[0];

        const {
            pos: nextPos,
            rotate: nextRot,
            time: nextTime,
            sneak: nextSneak = 0,
            extra_data: nextExtraData = null,
        } = this.netBuffer[1];

        let iterp = (correctedTime - prevTime) / (nextTime - prevTime);

        // prevent extrapolation.
        // it should be processed by another way
        // or will be bug with jump
        iterp = Mth.clamp(iterp, 0, 1);

        tPos.lerpFrom(prevPos, nextPos, iterp);

        const sneak = Mth.lerp(iterp, prevSneak, nextSneak);
        const extra_data = nextExtraData;

        const rot = nextRot && prevRot
            ? tRot.lerpFromAngle(prevRot, nextRot, iterp, true)
            : null

        return this.applyState(tPos, rot, sneak, extra_data);
    }

    update() {
        this.processNetState();
        this.updateAABB();
    }

    /**
     * Делает те же изменения, что обычно выполняет {@link update}, но не наснове сетевого состояния этого объекта,
     * а на основе заданных (локально вычисленных) значений.
     * Конкретно: устанавливает позицию и поворот, а также вызывает необходимые связанные изменения (например, обновление AABB).
     * Из {@link netBuffer} обновляет extra_data, если оно задано.
     */
    forceLocalUpdate(pos: IVector | null, yaw: float | null): void {
        if (pos) {
            this.pos = pos
        }
        if (yaw != null) {
            this.yaw = yaw
        }
        if (pos || yaw != null) {
            this.updateAABB()
        }
        const netState = this.netBuffer.shift()
        if (netState?.extra_data) {
            this.extra_data = netState.extra_data
        }
    }

    updateAABB(): void {
        this.aabb ??= new AABBDrawable();
        // используем именно pos, а не tPos. tPos не всегда обновлен (например, когда обработали только 1 пакет из буфере)
        this.aabb.setBottomHeightRadius(this.pos, this.height, this.width / 2)
    }

}