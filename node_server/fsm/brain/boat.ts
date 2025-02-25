import { FSMBrain } from "../brain.js";
import { BLOCK } from "@client/blocks.js";
import { WorldAction } from "@client/world_action.js";
import type { EnumDamage } from "@client/enums/enum_damage.js";

export class Brain extends FSMBrain {

    constructor(mob) {
        super(mob);
        //
        this.stack.pushState(this.doNothing)
    }

    // Если убили моба
    onKill(actor, type_damage) {
        const mob = this.mob;
        const world = mob.getWorld();
        const actions = new WorldAction();
        if(this.mob.config.drop_on_kill) {
            const block_name = this.mob.config.drop_on_kill
            const block = BLOCK.fromName(block_name)
            if(!block) {
                console.error(`error_invalid_kill_drop_block|${block_name}`)
            }
            actions.addDropItem({
                pos: mob.pos,
                items: [
                    {
                        id: block.id,
                        count: 1
                    }
                ],
                force: true
            })
        }
        actions.addPlaySound({ tag: 'madcraft:block.pig', action: 'death', pos: mob.pos.clone() });
        world.actions_queue.add(actor, actions);
    }

}