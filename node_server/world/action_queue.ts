import { SimpleQueue } from "@client/helpers.js";
import type {WorldAction} from "@client/world_action.js";
import type {ServerWorld} from "../server_world.js";
import type {ServerPlayer} from "../server_player.js";
import type {TQueuedNetworkMessage} from "../network/packet_reader.js";
import {PacketReader} from "../network/packet_reader.js";

const MAX_ACTIONS_QUEUE_PROCESSING_TIME_MS = 200

type TQueuedAction = {
    actor: ServerPlayer | null
    actions: WorldAction
}

// Queue for actions
export class WorldActionQueue {
    world: ServerWorld;
    private list    = new SimpleQueue<TQueuedAction | TQueuedNetworkMessage>()
    private runningNow = false

    /**
     * Действия, порожденные во время обработки жлемента этой очереди.
     * После окончания обработки этого элемента, они добавятся в начало очереди - в порядке создания.
     * Этот масив нужен для соранения порядка: если добавлять действия в начало по одному с помощью unshift,
     * порядок изменится на обратный.
     */
    private childActions: TQueuedAction[]

    constructor(world: ServerWorld) {
        this.world = world
    }

    get length() { return this.list.length }

    add(actor: ServerPlayer | null, actions: WorldAction): void {
        if (this.runningNow) {
            this.childActions.push({actor, actions})
        } else {
            this.list.push({actor, actions})
        }
    }

    addFirst(actor: ServerPlayer | null, actions: WorldAction): void {
        this.list.unshift({actor, actions});
    }

    addNetworkMessage(item: TQueuedNetworkMessage): void {
        this.list.push(item)
    }

    async run() {
        const list = this.list
        const world = this.world
        const childActions = this.childActions = [] // пересоздаем масссив ради сборки мусора
        const pn_stop = performance.now() + MAX_ACTIONS_QUEUE_PROCESSING_TIME_MS
        let firstReQueuedMsg: TQueuedNetworkMessage | null = null // чтобы остановиться если встретили то же сообщене повторно

        this.runningNow = true

        while(list.length > 0 && performance.now() <= pn_stop) {
            const actionOrMessage = list.shift()

            // если это сетевое сообщение
            if ((actionOrMessage as TQueuedNetworkMessage).reader) {
                const msg = actionOrMessage as TQueuedNetworkMessage
                if (!PacketReader.canProcess(msg.player, msg.packet)) {
                    continue // может, игрок умер или был удален пока команда лежала в очереди, и ее выполнение стало невозможным
                }
                if (msg === firstReQueuedMsg) {
                    // мы уже помещали его в очередь в этом вызове; вернем его в очередь и прервем выполнение
                    list.unshift(msg)
                    break
                }
                try {
                    const resp = await msg.reader.read(msg.player, msg.packet)
                    if (!resp) {
                        firstReQueuedMsg ??= msg
                        list.push(msg)
                    }
                } catch(e) {
                    world.packet_reader.onError(msg.player, msg.reader, e)
                    // если эта команда породила дочерние действия - не добавлять их (высокий шанс что они некорректны)
                    childActions.length = 0
                    continue // не бросать исключение, продолжать выполнять очередь
                }

            } else { // это не сетевое сообщение, значит действие
                const item = actionOrMessage as TQueuedAction

                // Check player is connected
                const player_session = item.actor?.session;
                if(player_session) {
                    const player = world.players.get(player_session.user_id);
                    if(!player) {
                        continue;
                    }
                    // if the action was postponed until a chunk loads, and the player reconnected - update it
                    item.actor = player;
                }
                // Apply actions
                let pn_apply = performance.now();
                try {
                    await world.applyActions(item.actor, item.actions);
                } catch (e) {
                    console.error('world.applyActions exception ', e)
                    // если это действие породило дочерние - не добавлять их (высокий шанс что они некорректны)
                    childActions.length = 0
                    continue // не бросать исключение, продолжать выполнять очередь
                }
                if(item.actions.notify) {
                    const notify = item.actions.notify;
                    if(('user_id' in notify) && ('user_id' in notify)) {
                        if(notify.total_actions_count == 1) {
                            notify.pn = pn_apply;
                        }
                        if('pn' in notify) {
                            const elapsed = Math.round(performance.now() - notify.pn) / 1000;
                            const message = `${notify.message} for ... ${elapsed} sec`;
                            world.chat.sendSystemChatMessageToSelectedPlayers(message, [notify.user_id]);
                        } else {
                            notify.pn = performance.now();
                        }
                    }
                }
            }

            // если были порождены новые действия - добавить их в начало очереди в том же порядке
            if (childActions.length) {
                for(let i = childActions.length - 1; i >= 0; i--) {
                    list.unshift(childActions[i])
                }
                childActions.length = 0
            }
        }
        this.runningNow = false
    }

}