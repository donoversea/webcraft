import {CraftTable, InventoryWindow, ChestWindow, CreativeInventoryWindow} from "./window/index.js";
import {DIRECTION, Vector, Helpers} from "./helpers.js";
import {RecipeManager} from "./recipes.js";
import {BLOCK} from "./blocks.js";
import {Resources} from "./resources.js";

// Player inventory
export class Inventory {

    constructor(player, hud, cb_onSelect) {
        this.player         = player;
        this.hud            = hud;
        this.current_item   = null;
        this.max_count      = 36;
        this.hotbar_count   = 9;
        this.items          = [];
        this.cb_onSelect    = cb_onSelect;
        for(let i = 0; i < this.max_count; i++) {
            this.items.push(null);
        }
        //
        this.restoreItems(player.state.inventory);
        this.onSelect = (item) => {};
        this.select(this.player.state.inventory.current.index);
        // Recipe manager
        this.recipes = new RecipeManager();
    }

    // Open window
    open() {
        if(this.player.world.game_mode.isCreative()) {
            Game.hud.wm.getWindow('frmCreativeInventory').toggleVisibility();
        } else {
            Game.hud.wm.getWindow('frmInventory').toggleVisibility();
        }
    }

    // Return items from inventory
    exportItems() {
        let resp = {
            current: {
                index: this.player.state.inventory.current.index,
                index2: this.player.state.inventory.current.index2
            },
            items: []
        }
        for(var item of this.items) {
            let t = null;
            if(item) {
                t = {
                    id:         item.id,
                    count:      item.count,
                    power:      item.power
                };
                // Individual properties
                for(let prop of ['entity_id', 'entity_name']) {
                    t[prop] = null;
                    if(item.hasOwnProperty(prop)) {
                        t.entity_id = item[prop];
                    }
                }
            }
            resp.items.push(t);
        }
        return resp;
    }

    // Возвращает список того, чего и в каком количестве не хватает в текущем инвентаре по указанному списку
    hasResources(resources) {
        let resp = [];
        for(let resource of resources) {
            let r = {
                item_id: resource.item_id,
                count: resource.count
            };
            // Each all items in inventoryy
            for(var item of this.items) {
                if(!item) {
                    continue;
                }
                if(item.id == r.item_id) {
                    if(item.count > r.count) {
                        r.count = 0;
                    } else {
                        r.count -= item.count;
                    }
                    if(r.count == 0) {
                        break;
                    }
                }
            }
            if(r.count > 0) {
                resp.push(r);
            }
        }
        return resp;
    }

    //
    restoreItems(saved_inventory) {
        let items = saved_inventory.items;
        this.items = []; // new Array(this.max_count);
        for(let i = 0; i < this.max_count; i++) {
            this.items.push(null);
        }
        this.player.state.inventory.current.index = 0;
        for(let k in items) {
            if(k >= this.items.length) {
                console.error('Limit reach of inventory');
                break;
            }
            let item = items[k];
            if(item) {
                const block = {...BLOCK.fromId(item.id)};
                if(block) {
                    item = Object.assign(block, items[k]);
                    if(!item.count) {
                        item.count = 1;
                    }
                    this.items[k] = item;
                }
            }
        }
    }

    // Return current active item in hotbar
    getCurrent() {
        return this.current_item;
    }

    getLeftIndex() {
        return this.player.state.inventory.current.index2;
    }

    getRightIndex() {
        return this.player.state.inventory.current.index;
    }

    // Refresh
    refresh(changed) {
        this.player.saveInventory(this.exportItems());
        if(this.hud) {
            this.hud.refresh();
            try {
                let frmRecipe = Game.hud.wm.getWindow('frmRecipe');
                frmRecipe.paginator.update();
            } catch(e) {
                // do nothing
            }
        }
    }

    // decrementByItemID
    decrementByItemID(item_id, count) {
        for(let i in this.items) {
            let item = this.items[i];
            if(!item || item.count < 1) {
                continue;
            }
            if(item.id == item_id) {
                if(item.count >= count) {
                    item.count -= count;
                    if(item.count < 1) {
                        this.items[i] = null;
                    }
                    break;
                } else {
                    count -= item.count;
                    item.count = 0;
                    this.items[i] = null;
                }
            }
        }
    }

    // Increment
    increment(mat) {
        if(!mat.id) {
            throw 'Empty mat ID';
        }
        let block = BLOCK.BLOCK_BY_ID.get(mat.id);
        if(!block) {
            throw 'Invalid mat ID';
        }
        // Restore material default properties
        mat = Object.assign({
            count:              1,
            name:               block.name,
            tags:               block.tags,
            inventory_icon_id:  block.inventory_icon_id,
            max_in_stack:       block.max_in_stack,
        }, mat);
        let item_max_count = mat.max_in_stack;
        // Update cell if exists
        for(let i in this.items) {
            let item = this.items[i];
            if(item) {
                if(item.id == mat.id) {
                    if(this.player.world.game_mode.isCreative()) {
                        return;
                    }
                    if(item.count < item_max_count) {
                        if(item.count + mat.count <= item_max_count) {
                            item.count = Math.min(item.count + mat.count, item_max_count);
                            this.refresh(true);
                            return;
                        } else {
                            let remains = (item.count + mat.count) - item_max_count;
                            item.count = item_max_count;
                            mat.count = remains;
                            this.refresh(true);
                        }
                    }
                }
            }
        }
        // Start new slot
        for(let i = 0; i < this.items.length; i++) {
            if(!this.items[i]) {
                this.items[i] = {...mat};
                if(this.items[i].count > item_max_count) {
                    mat.count -= item_max_count;
                    this.items[i].count = item_max_count;
                } else {
                    mat.count = 0;
                }
                delete(this.items[i].texture);
                if(i == this.player.state.inventory.current.index) {
                    this.select(i);
                }
                if(mat.count > 0) {
                    this.increment(mat);
                }
                this.refresh(true);
                return;
            }
        }
    }
    
    // Decrement
    decrement() {
        if(!this.current_item || this.player.world.game_mode.isCreative()) {
            return;
        }
        this.current_item.count = Math.max(this.current_item.count - 1, 0);
        if(this.current_item.count < 1) {
            this.current_item = this.player.buildMaterial = this.items[this.player.state.inventory.current.index] = null;
        }
        this.refresh(true);
    }
    
    //
    setItem(index, item) {
        this.items[index] = item;
        // Обновить текущий инструмент у игрока
        this.select(this.player.state.inventory.current.index);
    }

    //
    select(index) {
        if(index < 0) {
            index = this.hotbar_count - 1;
        }
        if(index >= this.hotbar_count) {
            index = 0;
        }
        this.player.state.inventory.current.index = index;
        this.current_item = this.player.buildMaterial = this.items[index];
        this.refresh(false);
        this.onSelect(this.current_item);
    }

    next() {
        this.select(++this.player.state.inventory.current.index);
    }
    
    prev() {
        this.select(--this.player.state.inventory.current.index);
    }
    
    // Клонирование материала в инвентарь
    cloneMaterial(mat) {
        if(!this.player.world.game_mode.isCreative()) {
            return false;
        }
        const MAX = mat.max_in_stack;
        // Search same material with count < max
        for(let k in Object.keys(this.items)) {
            if(parseInt(k) >= this.hotbar_count) {
                break;
            }
            if(this.items[k]) {
                let item = this.items[k];
                if(item.id == mat.id) {
                    this.select(parseInt(k));
                    return this.refresh(false);
                }
            }
        }
        // Create in current cell if this empty
        if(this.player.state.inventory.current.index < this.hotbar_count) {
            let k = this.player.state.inventory.current.index;
            if(!this.items[k]) {
                this.items[k] = Object.assign({count: 1}, mat);
                delete(this.items[k].texture);
                this.select(parseInt(k));
                return this.refresh(true);
            }
        }
        // Start new cell
        for(let k in Object.keys(this.items)) {
            if(parseInt(k) >= this.hotbar_count) {
                break;
            }
            if(!this.items[k]) {
                this.items[k] = Object.assign({count: 1}, mat);
                delete(this.items[k].texture);
                this.select(parseInt(k));
                return this.refresh(true);
            }
        }
        // Replace current cell
        if(this.player.state.inventory.current.index < this.hotbar_count) {
            let k = this.player.state.inventory.current.index;
            this.items[k] = Object.assign({count: 1}, mat);
            delete(this.items[k].texture);
            this.select(parseInt(k));
            return this.refresh(true);
        }
    }

    // drawHUD
    drawHUD(hud) {
        if(!this.inventory_image) {
            return this.initUI();
        }
        if(!this.player.state.inventory.current.index) {
            this.player.state.inventory.current.index = 0;
        }
        hud.wm.centerChild();
    }

    // drawHotbar
    drawHotbar(hud, cell_size, pos) {
        if(!this.inventory_image) {
            return this.initUI();
        }
        hud.ctx.imageSmoothingEnabled = false;
        // 1. that.inventory_image
        // 2. inventory_selector
        // img,sx,sy,swidth,sheight,x,y,width,height
        const hud_pos = new Vector(pos.x, pos.y, 0);
        // style
        hud.ctx.font            = '18px Ubuntu';
        hud.ctx.textAlign       = 'right';
        hud.ctx.textBaseline    = 'bottom';
        for(const k in this.items) {
            const item = this.items[k];
            if(k >= this.hotbar_count) {
                break;
            }
            if(item) {
                if(!item.name) {
                    console.error(item);
                }
                let mat = BLOCK.fromId(item.id);
                if(mat.inventory_icon_id == 0 && mat.resource_pack.id != 'default') {
                    let c_front = BLOCK.calcMaterialTexture(mat, DIRECTION.FORWARD);
                    let image = mat.resource_pack.getTexture(mat.texture.id);
                    c_front = c_front.map((v) => v * image.width);
                    hud.ctx.drawImage(
                        image.texture.source,
                        c_front[0] - c_front[2] / 2,
                        c_front[1] - c_front[3] / 2,
                        c_front[2],
                        c_front[3],
                        hud_pos.x + cell_size / 2 - 18,
                        hud_pos.y + cell_size / 2 - 18,
                        48,
                        48
                    );
                } else {

                    const icon = BLOCK.getInventoryIconPos(
                        item.inventory_icon_id,
                        this.inventory_image.width,
                        this.inventory_image.width / 16
                    );
                    const DEST_SIZE = 64;

                    if(item.inventory_icon_id == 5) {
                        console.log(icon);
                    }

                    hud.ctx.drawImage(
                        this.inventory_image,
                        icon.x,
                        icon.y,
                        icon.width,
                        icon.height,
                        hud_pos.x + cell_size / 2 - 49 / 2 - 4,
                        hud_pos.y + cell_size / 2 - 48 / 2 - 2,
                        DEST_SIZE,
                        DEST_SIZE
                    );
                }
                if(item.count > 1) {
                    hud.ctx.textBaseline    = 'bottom';
                    hud.ctx.font            = '18px Ubuntu';
                    hud.ctx.fillStyle = '#000000ff';
                    hud.ctx.fillText(item.count, hud_pos.x + cell_size - 5, hud_pos.y + cell_size);
                    hud.ctx.fillStyle = '#ffffffff';
                    hud.ctx.fillText(item.count, hud_pos.x + cell_size - 5, hud_pos.y + cell_size - 2);
                }
                // Draw instrument life
                if(item.instrument_id && item.power < 1) {
                    let cx = hud_pos.x + 14;
                    let cy = hud_pos.y + 14;
                    let cw = 40;
                    let ch = 43;
                    hud.ctx.fillStyle = '#000000ff';
                    hud.ctx.fillRect(cx, cy + ch - 8, cw, 8);
                    //
                    let rgb = Helpers.getColorForPercentage(item.power);
                    hud.ctx.fillStyle = rgb.toCSS();
                    hud.ctx.fillRect(cx, cy + ch - 8, cw * item.power | 0, 4);
                }
            }
            hud_pos.x += cell_size;
        }
    }

    // initUI...
    initUI() {
        this.inventory_image = Resources.inventory.image;
        this.hud.add(this, 0);
        // CraftTable
        this.ct = new CraftTable(this.recipes, 0, 0, 352, 332, 'frmCraft', null, null, this);
        this.ct.visible = false;
        this.hud.wm.add(this.ct);
        // Inventory window
        this.frmInventory = new InventoryWindow(this.recipes, 10, 10, 352, 332, 'frmInventory', null, null, this);
        this.hud.wm.add(this.frmInventory);
        // Creative Inventory window
        this.frmCreativeInventory = new CreativeInventoryWindow(10, 10, 390, 416, 'frmCreativeInventory', null, null, this);
        this.hud.wm.add(this.frmCreativeInventory);
        // Chest window
        this.frmChest = new ChestWindow(10, 10, 352, 332, 'frmChest', null, null, this);
        this.hud.wm.add(this.frmChest);
    }

}