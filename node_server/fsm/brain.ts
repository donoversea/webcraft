import { FSMStack } from "./stack.js";
import {PrismarinePlayerControl, TPrismarineOptions} from "@client/prismarine-physics/using.js";
import { Vector } from "@client/helpers.js";
import { ServerClient } from "@client/server_client.js";
import type { Mob } from "../mob.js";
import { EnumDamage } from "@client/enums/enum_damage.js";
// import { EnumDifficulty } from "@client/enums/enum_difficulty.js";
import { FLUID_TYPE_MASK, FLUID_LAVA_ID, FLUID_WATER_ID } from "@client/fluid/FluidConst.js";
import { WorldAction } from "@client/world_action.js";
import type {MobControlParams} from "@client/control/player_control.js";
import type {World} from "@client/world.js";
import type {ServerWorld} from "../server_world.js";

const MUL_1_SEC = 20;

export class FSMBrain {

    #pos;
    world: ServerWorld
    prevPos: Vector;
    lerpPos: Vector;
    mob: Mob;
    stack: FSMStack;
    enabled = true // true если моб контролирует себя (а не кто-то контролирует его в вождении). Только вождение может менять это поле!
    _eye_pos: Vector;
    timer_health: number;
    timer_panic: number;
    timer_fire_damage: number;
    timer_lava_damage: number;
    timer_water_damage: number;
    time_fire: number;
    target: any;
    to: any;
    resistance_light: boolean;
    pc: PrismarinePlayerControl;
    under_id: any;
    legs_id: any;
    in_water: boolean;
    in_fire: boolean;
    in_lava: boolean;
    in_air: boolean;
    is_abyss: boolean;
    is_wall: boolean;
    is_fire: boolean;
    is_water: boolean;
    is_lava: boolean;
    is_gate: boolean;
    targets: any;

    constructor(mob: Mob) {
        this.mob = mob;
        this.stack = new FSMStack();
        this.world = mob.getWorld()
        this.#pos = new Vector(0, 0, 0);
        this._eye_pos = new Vector(0, 0, 0);
        this.prevPos    = new Vector(mob.pos);
        this.lerpPos    = new Vector(mob.pos);
        this.pc = new PrismarinePlayerControl(this.world as any as World, mob.pos, mob.config.physics)
        // таймеры
        this.timer_health = 0;
        this.timer_panic = 0;
        this.timer_fire_damage = 0;
        this.timer_lava_damage = 0;
        this.timer_water_damage = 0;
        this.time_fire = 0;
        // цель
        this.target = null;
        this.to = null;
        // защита
        this.resistance_light = true;
    }

    addStat(name : string, allowAdding : boolean = false) {
        const mobs = this.mob.getWorld().mobs
        mobs.getTickStatForMob(this.mob).add(name, allowAdding)
        mobs.ticks_stat.add(name, allowAdding)
    }

    tick(delta) {
        const chunk = this.mob.inChunk
        if (!chunk?.isReady()) {
            return
        }
        this.onLive();
        if (!this.enabled) {
            return
        }
        const stateFunctionUsed = this.stack.tick(delta, this);
        if (stateFunctionUsed) {
            this.addStat(stateFunctionUsed.func.name, true);
        }
        const driving = this.mob.driving
        if (driving) {
            // есть вождение, но моб сам им управляет. Обновить состояние вождения.
            driving.updateFromVehicle(this.mob)
            driving.applyToDependentParticipants(false)
        }
    }

    // Send current mob state to players
    sendState() {
        const mob = this.mob;
        const world = mob.getWorld();
        const chunk_over = mob.inChunk
        if (!chunk_over) {
            return;
        }
        const new_state = mob.exportState(true)
        // if state not changed
        if(!new_state) {
            return
        }
        const packets = [{
            name: ServerClient.CMD_MOB_UPDATE,
            data: new_state
        }];
        world.packets_queue.add(chunk_over.connections.keys(), packets);
    }

    /** Updates the control {@link pc} */
    updateControl(new_states: MobControlParams): void {
        this.pc.updateControlsFromMob(new_states, this.mob.rotate.z)

        /* The old code - slow

        const pc = this.pc;
        for (let [key, value] of Object.entries(new_states)) {
            switch (key) {
                case 'yaw': {
                    pc.player_state.yaw = value as float;
                    break;
                }
                default: {
                    pc.controls[key] = value;
                    break;
                }
            }
        }
        */
    }

    applyControl(delta : float) {
        if (!this.enabled) {
            return
        }
        this.pc.tick(delta);// * (this.timer_panic > 0 ? 4 : 1));
        this.mob.updateStateFromControl()
    }

    // угол между таргетом и мобом
    angleTo(target) {
        const pos = this.mob.pos;
        const angle = Math.atan2(target.x - pos.x, target.z - pos.z);
        return (angle > 0) ? angle : angle + 2 * Math.PI;
    }

    /**
     * На этом месте можно стоять?
     */
    isStandAt(position: Vector): boolean {
        const pos = position.floored();
        const world = this.mob.getWorld()
        let block = world.getBlock(pos);
        const AIR = world.block_manager.AIR
        if (block && ((block.id == AIR.id && block.fluid == 0) || (block.material.style_name == 'planting'))) {
            block = world.getBlock(pos.offset(0, -1, 0));
            if (block && block.id != AIR.id) {
                block = world.getBlock(pos.offset(0, 1, 0));
                if (block && ((block.id == AIR.id && block.fluid == 0) || (block.material.style_name == 'planting'))) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Returns the position of the eyes of the mob
     * @returns {Vector}
     */
    getEyePos() {
        const mob = this.mob;
        const subY = 0;
        //if(this.state.sitting) {
        //    subY = this.pc.physics.playerHeight * 1/3;
        //}
        return this._eye_pos.set(mob.pos.x, mob.pos.y + this.height * 0.85 - subY, mob.pos.z);
    }

    get height(): float {
        return this.pc.playerHeight
    }

    get distance_view(): int { return this.mob.config.distance_view }

    // контроль жизней и состяния моба
    onLive() {
        const mob = this.mob;
        const config = mob.config
        const world = mob.getWorld();
        const bm = world.block_manager
        const chunk = mob.inChunk
        if (!chunk) {
            return;
        }
        const forward = mob.pos.add(mob.forward).floored();
        const ahead = chunk.getBlock(forward.offset(0, 1, 0).floored());
        const alegs = chunk.getBlock(forward);
        const under = chunk.getBlock(forward.offset(0, -1, 0));
        const abyss = chunk.getBlock(forward.offset(0, -2, 0));
        const head = chunk.getBlock(this.getEyePos().floored());
        const legs = chunk.getBlock(mob.pos.floored());
        this.under_id = under.id;
        this.legs_id = legs.id;
        this.in_water = (head.id == 0 && (head.fluid & FLUID_TYPE_MASK) === FLUID_WATER_ID);
        this.in_fire = (legs.id == bm.FIRE.id || legs.id == bm.CAMPFIRE.id);
        this.in_lava = (legs.id == 0 && (legs.fluid & FLUID_TYPE_MASK) === FLUID_LAVA_ID);
        this.in_air = (head.fluid == 0 && (legs.fluid & FLUID_TYPE_MASK) === FLUID_WATER_ID);
        this.is_abyss = under.id == 0 && under.fluid == 0 && abyss.id == 0 && abyss.fluid == 0 && alegs.id == 0 && alegs.fluid == 0;
        this.is_wall = (ahead?.id != 0 && ahead?.id != -1 && ahead?.material?.style_name != 'planting' && ahead?.material?.style_name != 'chicken_nest') || (alegs?.material?.style_name == 'fence');
        this.is_fire = (alegs.id == bm.FIRE.id || alegs.id == bm.CAMPFIRE.id);
        this.is_water = ((under.fluid & FLUID_TYPE_MASK) === FLUID_WATER_ID) && this.time_fire == 0;
        this.is_lava = ((under.fluid & FLUID_TYPE_MASK) === FLUID_LAVA_ID);
        this.is_gate = ahead.id != bm.AIR.id;
        // стоит в лаве
        if (this.in_lava) {
            if (this.timer_lava_damage <= 0) {
                this.timer_lava_damage = MUL_1_SEC;
                this.onDamage(2, EnumDamage.LAVA, null);
            } else {
                this.timer_lava_damage--;
            }
            this.time_fire = Math.max(10 * MUL_1_SEC, this.time_fire);
        } else {
            this.timer_lava_damage = 0;
        }
        // стоит в огне или на свете
        if (this.in_fire || (world.getLight() > 11
            && (chunk.tblocks.lightData && (legs.lightValue >> 8) === 0)
            && !this.resistance_light)) {
            this.time_fire = Math.max(8 * MUL_1_SEC, this.time_fire);
        }
        // нехватка воздуха
        if (this.in_water && config.can_asphyxiate) {
            this.time_fire = 0;
            if (this.timer_water_damage >= MUL_1_SEC) {
                this.timer_water_damage = 0;
                this.onDamage(1, EnumDamage.WATER, null);
            } else {
                this.timer_water_damage++;
            }
        } else {
            this.timer_water_damage = 0;
        }
        // горение
        if (this.time_fire > 0) {
            if (this.timer_fire_damage >= MUL_1_SEC) {
                this.timer_fire_damage = 0;
                this.onDamage(1, EnumDamage.FIRE, null);
            } else {
                this.timer_fire_damage++;
            }
        } else {
            this.time_fire--;
        }
        // update extra data
        this.mob.extra_data.time_fire = this.time_fire;
        // регенерация жизни
        if (this.timer_health >= 10 * MUL_1_SEC) {
            mob.indicators.live = Math.min(mob.indicators.live + 1, this.mob.config.health);
            this.timer_health = 0;
        } else {
            this.timer_health++;
        }
        // паника
        if (this.timer_panic > 0) {
            this.timer_panic--;
        }
        this.addStat('onLive');

        this.onFind();
    }

    // поиск игроков или мобов
    onFind() {
        if (this.target || !this.targets || this.targets.length == 0 || this.distance_view < 1) {
            return;
        }
        const mob = this.mob;
        const world = mob.getWorld();
        const players = world.getPlayersNear(mob.pos, this.distance_view, false);
        const friends = [];
        for (const player of players) {
            if (this.targets.includes(player.state.hands.right.id)) {
                friends.push(player);
            }
        }
        if (friends.length > 0) {
            const rnd = (Math.random() * friends.length) | 0;
            const player = friends[rnd];
            this.target = player;
        }
        this.addStat('onFind');
    }

    // идти за игроком, если в руках нужный предмет
    doCatch(delta) {
        this.timer_panic = 0;
        const mob = this.mob;
        if (!this.target || this.distance_view < 1) {
            this.target = null;
            this.stack.replaceState(this.doStand);
            return;
        }
        const dist = mob.pos.distance(this.target.state.pos);
        if (this.target.game_mode.isSpectator() || dist > this.distance_view || !this.targets.includes(this.target.state.hands.right.id)) {
            this.target = null;
            this.stack.replaceState(this.doStand);
            return;
        }
        mob.rotate.z = this.angleTo(this.target.state.pos);
        const forward = (dist > 1.5 && !this.is_wall && !this.is_abyss) ? true : false;
        this.updateControl({
            forward: forward,
            jump: this.is_water,
            sneak: false
        });
        this.applyControl(delta);
        this.sendState();
    }

    /** Стоит на месте, но иногда начинает идти; реагирует на разыне ситуации. См. также {@link doNothing} */
    doStand(delta) {
        // нашел цель
        if (this.target) {
            this.stack.replaceState(this.doCatch);
            return;
        }
        // попал в воду
        if (this.in_water) {
            this.stack.replaceState(this.doFindGround);
            return;
        }
        if (Math.random() < 0.05 || this.timer_panic > 0) {
            this.stack.replaceState(this.doForward);
            return;
        }
        const mob = this.mob;
        this.updateControl({
            forward: false,
            jump: false,
            sneak: false
        });
        this.applyControl(delta);
        this.sendState();
    }

    /** Не делает ниего, ни при каких обстоятелствах. Для неодушевленных объектов типа лодки. См. также {@link doStand} */
    doNothing(delta: float): void {
        this.updateControl({
            forward: false,
            jump: false,
            sneak: false,
            pitch: false
        })
        this.applyControl(delta)
        this.sendState()
    }

    // просто ходит
    doForward(delta) {
        const mob = this.mob;
        // нашел цель
        if (this.target) {
            this.stack.replaceState(this.doCatch);
            return;
        }
        // попал в воду
        if (this.in_water) {
            this.stack.replaceState(this.doFindGround);
            return;
        }
        // обход препятсвия
        if (this.is_wall || this.is_fire || this.is_lava || this.is_water) {
            mob.rotate.z = mob.rotate.z + (Math.PI / 2) + (Math.random() - Math.random()) * Math.PI / 8;
            this.stack.replaceState(this.doStand);
            return;
        }
        if (Math.random() < 0.05) {
            mob.rotate.z = mob.rotate.z + (Math.random() - Math.random()) * Math.PI / 12;
            this.stack.replaceState(this.doStand);
            return;
        }
        this.updateControl({
            forward: true,
            jump: false,
            sneak: false,
            pitch: this.timer_panic > 0
        });
        this.applyControl(delta);
        this.sendState();
    }

    // поиск суши
    doFindGround(delta) {
        const mob = this.mob;
        // нашел цель
        if (this.target) {
            this.stack.replaceState(this.doCatch);
            return;
        }
        // находим пересечение сред
        if (this.in_air) {
            const angle_random = mob.rotate.z + (Math.random() - Math.random()) * Math.PI / 8;
            const ray = this.world.raycaster.get(mob.pos,
                new Vector(Math.sin(angle_random), 0, Math.cos(angle_random)),
                32, null, false, false, this.mob
            )
            if (ray) {
               const to = new Vector(ray.x, ray.y + 1, ray.z);
               if (!this.to || (this.isStandAt(to) && mob.pos.distance(to) < mob.pos.distance(this.to))) {
                   this.to = to;
               }
            }
            if (!this.to || !this.isStandAt(this.to)) {
                this.to = null;
                mob.rotate.z += (Math.random()  * Math.PI / 12);
            }
        }

        if (this.to) {
            const dist = mob.pos.distance(this.to);
            mob.rotate.z = this.angleTo(this.to);
            if (dist < 0.5) {
                this.stack.replaceState(this.doStand);
                return;
            }
        }

        this.updateControl({
            forward: this.to ? true : false,
            jump: this.in_water,
            sneak: false
        });
        this.applyControl(delta);
        this.sendState();
    }

    /**
    * Нанесен урон по мобу
    * val - количество урона
    * type_damage - от чего умер[упал, сгорел, утонул]
    * actor - игрок или пероснаж
    */
    onDamage(val : number, type_damage : EnumDamage, actor) {
        const mob = this.mob;
        const world = mob.getWorld();
        if (actor && mob.config.damagePushes && this.enabled && [EnumDamage.CRIT, EnumDamage.SNOWBALL].includes(type_damage)) {
            const pos = actor?.state?.pos ?? actor.pos
            const velocity = mob.pos.sub(pos).normSelf()
            velocity.y = 0.2
            mob.addVelocity(velocity)
        }
        mob.indicators.live -= val
        mob.extra_data.health = Math.round(mob.indicators.live * 100 / mob.config.health)
        if (mob.indicators.live <= 0) {
            mob.kill();
            this.onKill(actor, type_damage);
        } else {
            const actions = new WorldAction();
            const mob_type = mob.skin.model_name.split('/')[1]
            actions.addPlaySound({ tag: 'madcraft:block.' + mob_type, action: 'hurt', pos: mob.pos.clone() });
            world.actions_queue.add(actor, actions);
            this.onPanic();
            mob.markDirty();
        }
    }

    // паника моба от урона
    onPanic() {
        const mob = this.mob;
        this.timer_panic = mob.config.timer_panic ?? 80;
        if (this.timer_panic && this.enabled) {
            this.target = null;
            mob.rotate.z = 2 * Math.random() * Math.PI;
            this.stack.replaceState(this.doStand);
        }
    }

    /**
    * Моба убили
    * actor - игрок или пероснаж
    * type_damage - от чего умер[упал, сгорел, утонул]
    */
    onKill(actor, type_damage) {
    }

    /**
     * Использовать предмет на мобе
     * @param actor игрок
     * @param item item
     */
    onUse(actor : any, item : any) : boolean{
        return false;
    }

}