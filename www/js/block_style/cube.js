"use strict";

import {DIRECTION, MULTIPLY, QUAD_FLAGS, Vector} from '../helpers.js';
import {impl as alea} from "../../vendors/alea.js";
import {BLOCK, WATER_BLOCKS_ID} from "../blocks.js";
import {CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z} from "../chunk.js";
import {CubeSym} from "../core/CubeSym.js";
import glMatrix from "../../vendors/gl-matrix-3.3.min.js"
import { AABB, AABBSideParams, pushAABB } from '../core/AABB.js';

const {mat3} = glMatrix;

const defaultPivot = [0.5, 0.5, 0.5];
const defaultMatrix = mat3.create();
const tempMatrix = mat3.create();
let DIRT_BLOCKS = null;

let randoms = new Array(CHUNK_SIZE_X * CHUNK_SIZE_Z);
let a = new alea('random_dirt_rotations');
for(let i = 0; i < randoms.length; i++) {
    randoms[i] = Math.round(a.double() * 100);
}

export function pushTransformed(
    vertices, mat, pivot,
    cx, cz, cy,
    x0, z0, y0,
    ux, uz, uy,
    vx, vz, vy,
    c0, c1, c2, c3,
    r, g, b,
    flags
) {
    pivot = pivot || defaultPivot;
    cx += pivot[0];
    cy += pivot[1];
    cz += pivot[2];
    x0 -= pivot[0];
    y0 -= pivot[1];
    z0 -= pivot[2];

    mat = mat || defaultMatrix;

    let tx = 0;
    let ty = 0;
    let tz = 0;

    // unroll mat4 matrix to mat3 + tx, ty, tz
    if (mat.length === 16) {
        mat3.fromMat4(tempMatrix, mat);

        tx = mat[12];
        ty = mat[14]; // flip
        tz = mat[13]; // flip

        mat = tempMatrix;
    }

    vertices.push(
        cx + x0 * mat[0] + y0 * mat[1] + z0 * mat[2] + tx,
        cz + x0 * mat[6] + y0 * mat[7] + z0 * mat[8] + ty,
        cy + x0 * mat[3] + y0 * mat[4] + z0 * mat[5] + tz,

        ux * mat[0] + uy * mat[1] + uz * mat[2],
        ux * mat[6] + uy * mat[7] + uz * mat[8],
        ux * mat[3] + uy * mat[4] + uz * mat[5],

        vx * mat[0] + vy * mat[1] + vz * mat[2],
        vx * mat[6] + vy * mat[7] + vz * mat[8],
        vx * mat[3] + vy * mat[4] + vz * mat[5],

        c0, c1, c2, c3, r, g, b, flags
    );
}

export default class style {

    static getRegInfo() {
        return {
            styles: ['cube', 'default'],
            func: this.func
        };
    }

    static isOnCeil(block) {
        return block.extra_data && block.extra_data.point.y >= .5; // на верхней части блока (перевернутая ступенька, слэб)
    }

    // Pushes the vertices necessary for rendering a specific block into the array.
    static func(block, vertices, chunk, x, y, z, neighbours, biome, unknown, matrix = null, pivot = null, force_tex) {

        if(!block || typeof block == 'undefined' || block.id == BLOCK.AIR.id) {
            return;
        }

        if(!block.material) {
            console.error('block', JSON.stringify(block), block.id);
            debugger;
        }

        const material              = block.material;
        let width                   = material.width ? material.width : 1;
        let height                  = material.height ? material.height : 1;
        const drawAllSides          = width != 1 || height != 1;
        const into_pot              = block.hasTag('into_pot');

        if(into_pot) {
            width = 8/32;
            let aabb = new AABB();
            aabb.set(
                x + .5 - width/2,
                y,
                z + .5 - width/2,
                x + .5 + width/2,
                y + 1 - 6/32,
                z + .5 + width/2
            );
            let c_up = BLOCK.calcMaterialTexture(material, DIRECTION.UP);
            let c_down = BLOCK.calcMaterialTexture(material, DIRECTION.DOWN);
            let c_side = BLOCK.calcMaterialTexture(material, DIRECTION.LEFT);
            // Push vertices down
            pushAABB(
                vertices,
                aabb,
                pivot,
                matrix,
                {
                    up:     new AABBSideParams(c_up, 0, 1),
                    down:   new AABBSideParams(c_down, 0, 1),
                    south:  new AABBSideParams(c_side, 0, 1),
                    north:  new AABBSideParams(c_side, 0, 1),
                    west:   new AABBSideParams(c_side, 0, 1),
                    east:   new AABBSideParams(c_side, 0, 1),
                },
                true,
                new Vector(x, y, z)
            );
            return;
        }

        if(material.tags.indexOf('jukebox') >= 0) {
            const disc = block?.extra_data?.disc || null;
            if(disc) {
                worker.postMessage(['play_disc', {
                    ...disc,
                    dt: block.extra_data?.dt,
                    pos: chunk.coord.add(new Vector(x, y, z))
                }]);
            }
        }

        let canDrawFace = (neighbourBlock) => {
            if(!neighbourBlock) {
                return true;
            }
            let resp = drawAllSides || neighbourBlock.material?.transparent;
            if(resp) {
                if(block.id == neighbourBlock.id) {
                    resp = false;
                } else {
                    if(WATER_BLOCKS_ID.indexOf(block.id) >= 0 && WATER_BLOCKS_ID.indexOf(neighbourBlock.id) >= 0) {
                        return false;
                    }
                }
            }
            return resp;
        };

        // Can change height
        let bH = 1.0;
        if(material.is_fluid) {
            bH = Math.min(block.power, .9)
            let blockOver = neighbours.UP;
            if(blockOver) {
                if(blockOver.material.is_fluid) {
                    bH = 1.0;
                }
            }
            block.bH = bH;
        }

        //
        let canDrawTOP = canDrawFace(neighbours.UP) || bH < 1;
        let canDrawDOWN = canDrawFace(neighbours.DOWN);
        let canDrawSOUTH = canDrawFace(neighbours.SOUTH);
        let canDrawNORTH = canDrawFace(neighbours.NORTH);
        let canDrawWEST = canDrawFace(neighbours.WEST);
        let canDrawEAST = canDrawFace(neighbours.EAST);
        if(!canDrawTOP && !canDrawDOWN && !canDrawSOUTH && !canDrawNORTH && !canDrawWEST && !canDrawEAST) {
            return;
        }

        const cardinal_direction    = block.getCardinalDirection();
        let flags                   = material.light_power ? QUAD_FLAGS.NO_AO : 0;
        let sideFlags               = flags;
        let upFlags                 = flags;
        let c;

        // Texture color multiplier
        let lm = MULTIPLY.COLOR.WHITE;
        if(block.hasTag('mask_biome')) {
            lm = biome.dirt_color; // MULTIPLY.COLOR.GRASS;
            sideFlags = QUAD_FLAGS.MASK_BIOME;
            upFlags = QUAD_FLAGS.MASK_BIOME;
        }
        if(block.hasTag('mask_color')) {
            lm = material.mask_color;
            sideFlags = QUAD_FLAGS.MASK_BIOME;
            upFlags = QUAD_FLAGS.MASK_BIOME;
        }

        let DIRECTION_UP        = DIRECTION.UP;
        let DIRECTION_DOWN      = DIRECTION.DOWN;
        let DIRECTION_BACK      = DIRECTION.BACK
        let DIRECTION_RIGHT     = DIRECTION.RIGHT
        let DIRECTION_FORWARD   = DIRECTION.FORWARD
        let DIRECTION_LEFT      = DIRECTION.LEFT;

        if(material.can_rotate) {
            DIRECTION_BACK      = CubeSym.dirAdd(CubeSym.inv(cardinal_direction), DIRECTION.BACK);
            DIRECTION_RIGHT     = CubeSym.dirAdd(CubeSym.inv(cardinal_direction), DIRECTION.RIGHT);
            DIRECTION_FORWARD   = CubeSym.dirAdd(CubeSym.inv(cardinal_direction), DIRECTION.FORWARD);
            DIRECTION_LEFT      = CubeSym.dirAdd(CubeSym.inv(cardinal_direction), DIRECTION.LEFT);
        }

        if(material.can_rotate && block.rotate) {
            if (CubeSym.matrices[cardinal_direction][4] <= 0) {
                //TODO: calculate canDrawTop and neighbours based on rotation
                canDrawTOP = true;
                canDrawDOWN = true;
                canDrawSOUTH = true;
                canDrawNORTH = true;
                canDrawWEST = true;
                canDrawEAST = true;
                DIRECTION_BACK = DIRECTION.BACK;
                DIRECTION_RIGHT = DIRECTION.RIGHT;
                DIRECTION_FORWARD = DIRECTION.FORWARD;
                DIRECTION_LEFT = DIRECTION.LEFT;
                //use matrix instead!
                if (matrix) {
                    mat3.multiply(tempMatrix, matrix, CubeSym.matrices[cardinal_direction]);
                    matrix = tempMatrix;
                } else {
                    matrix = CubeSym.matrices[cardinal_direction];
                }
            }
        }

        if(material.style == 'ladder') {
            width = 1;
            height = 1;
        }

        if(material.layering) {
            if(block.extra_data) {
                height = block.extra_data?.height || height;
            }
            if(block.properties.layering.slab) {
                let on_ceil = style.isOnCeil(block);
                if(on_ceil) {
                    y += block.properties.layering.height;
                }
            }
        }

        // Убираем шапку травы с дерна, если над ним есть непрозрачный блок
        if(!DIRT_BLOCKS) {
            DIRT_BLOCKS = [BLOCK.DIRT.id, BLOCK.DIRT_PATH.id, BLOCK.SNOW_DIRT.id];
        }
        if(DIRT_BLOCKS.indexOf(block.id) >= 0) {
            if(neighbours.UP && neighbours.UP.material && (!neighbours.UP.material.transparent || neighbours.UP.material.is_fluid || (neighbours.UP.id == BLOCK.DIRT_PATH.id))) {
                DIRECTION_UP        = DIRECTION.DOWN;
                DIRECTION_BACK      = DIRECTION.DOWN;
                DIRECTION_RIGHT     = DIRECTION.DOWN;
                DIRECTION_FORWARD   = DIRECTION.DOWN;
                DIRECTION_LEFT      = DIRECTION.DOWN;
                sideFlags = 0;
                height = 1;
                upFlags = 0;
            }
        }

        // getAnimations...
        let getAnimations = (side) => {
            if(!material.texture_animations) {
                return 1;
            }
            if(side in material.texture_animations) {
                return material.texture_animations[side];
            } else if('side' in material.texture_animations) {
                return material.texture_animations['side'];
            }
            return 1;
        };

        // Top
        if(canDrawTOP) {
            c = force_tex || BLOCK.calcMaterialTexture(material, DIRECTION_UP);
            let top_vectors = [1, 0, 0, 0, 1, 0];
            // Поворот текстуры травы в случайном направлении (для избегания эффекта мозаичности поверхности)
            if(block.id == BLOCK.DIRT.id) {
                const rv = randoms[(z * CHUNK_SIZE_X + x + y * CHUNK_SIZE_Y) % randoms.length] % 4;
                switch(rv) {
                    case 0: {
                        top_vectors = [0, -1, 0, 1, 0, 0];
                        break;
                    }
                    case 1: {
                        top_vectors = [-1, 0, 0, 0, -1, 0];
                        break;
                    }
                    case 2: {
                        top_vectors = [0, 1, 0, -1, 0, 0];
                        break;
                    }
                    default: {
                        break;
                    }
                }
            }

            let animations_up = getAnimations('up');

            pushTransformed(
                vertices, matrix, pivot,
                x, z, y,
                .5, 0.5, bH - 1 + height,
                ...top_vectors,
                c[0], c[1], -c[2], c[3],
                lm.r, lm.g, animations_up, flags | upFlags
            );

            if(material.is_fluid && material.transparent) {
                top_vectors = [
                    1, 0, 0,
                    0, -1, 0
                ];
                pushTransformed(
                    vertices, matrix, pivot,
                    x, z, y,
                    .5, 0.5, bH - 1 + height,
                    ...top_vectors,
                        c[0], c[1], -c[2], c[3],
                    lm.r, lm.g, animations_up, flags | upFlags);
            }
        }

        // Bottom
        if(canDrawDOWN) {
            c = force_tex || BLOCK.calcMaterialTexture(material, DIRECTION_DOWN);
            pushTransformed(
                vertices, matrix, pivot,
                x, z, y,
                0.5, 0.5, 0,
                1, 0, 0,
                0, -1, 0,
                c[0], c[1], -c[2], c[3],
                lm.r, lm.g, lm.b, flags | sideFlags);
        }

        const H = (bH - 1 + height);

        // South | Front/Forward
        if(canDrawSOUTH) {
            let animations_south = getAnimations('south');
            c = force_tex || BLOCK.calcMaterialTexture(material, DIRECTION_BACK, null, H);
            pushTransformed(
                vertices, matrix, pivot,
                x, z, y,
                .5, .5 - width / 2, H / 2,
                1, 0, 0,
                0, 0, H,
                c[0], c[1], c[2], -c[3],
                lm.r, lm.g, animations_south, flags | sideFlags);
        }

        // North
        if(canDrawNORTH) {
            let animations_north = getAnimations('north');
            c = force_tex || BLOCK.calcMaterialTexture(material, DIRECTION_FORWARD, null, H);
            pushTransformed(
                vertices, matrix, pivot,
                x, z, y,
                .5, .5 + width / 2, H / 2,
                1, 0, 0,
                0, 0, -H,
                c[0], c[1], -c[2], c[3],
                lm.r, lm.g, animations_north, flags | sideFlags);
        }

        // West
        if(canDrawWEST) {
            let animations_west = getAnimations('west');
            c = force_tex || BLOCK.calcMaterialTexture(material, DIRECTION_LEFT, null, H);
            pushTransformed(
                vertices, matrix, pivot,
                x, z, y,
                .5 - width / 2, .5, H / 2,
                0, 1, 0,
                0, 0, -H,
                c[0], c[1], -c[2], c[3],
                lm.r, lm.g, animations_west, flags | sideFlags);
        }

        // East
        if(canDrawEAST) {
            let animations_east = getAnimations('east');
            c = force_tex || BLOCK.calcMaterialTexture(material, DIRECTION_RIGHT, null, H);
            pushTransformed(
                vertices, matrix, pivot,
                x, z, y,
                .5 + width / 2, .5, H / 2,
                0, 1, 0,
                0, 0, H,
                c[0], c[1], c[2], -c[3],
                lm.r, lm.g, animations_east, flags | sideFlags);
        }

    }

}