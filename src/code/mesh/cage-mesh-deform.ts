import * as math from "mathjs";
import type { FileMesh, FileMeshVertex, Vec3 } from "./mesh";
import { add, distance, getDistVertArray, minus } from "./mesh-deform";
import { buildKDTree, knnSearch, nearestSearch, type KDNode } from "../misc/kd-tree-3";
import { WorkerPool } from "../misc/worker-pool";
import { FLAGS } from "../misc/flags";

//200 ~50ms -> 2
//100 ~26ms -> 4
//50 ~15.6ms -> 6
//25 ~4.5ms -> 22
//16 ~3ms -> 33
//8 ~3ms -> 33

/**
 * This is a naive (think thats what its called) implementation of the RBF deformer, it is extremely slow
 * Use RBFDeformerPatch instead
 */
export class RBFDeformer {
    refVerts: FileMeshVertex[] = []
    distVerts: FileMeshVertex[] = []

    weights: Vec3[] | undefined

    constructor(refMesh: FileMesh, distMesh: FileMesh) {
        let itsTime = 3 //we use this to skip verts because doing all is way too slow, even when skipping some its too slow

        //create arrays of refVerts and distVerts so that we can guarantee theyre identical in length
        const distVertArr = getDistVertArray(refMesh, distMesh)
        for (let i = 0; i < refMesh.coreMesh.verts.length; i++) {
            const distVert = distVertArr[i]
            if (distVert) {
                itsTime -= 1
                if (itsTime == 0) {
                    this.refVerts.push(refMesh.coreMesh.verts[i].clone())
                    this.distVerts.push(distVert.clone())
                    itsTime = 3
                }
            }
        }
        console.log(refMesh.coreMesh.verts.length)
        console.log(this.refVerts.length)
    }

    solve() {
        console.time("RBFDeformer.solve")

        console.time("RBFDeformer.solve.influenceMatrixArray")
        //create matrix VERT_COUNT x VERT_COUNT that defines influences each vertex has on every other vertex
        const influenceMatrixArray: number[][] = new Array(this.refVerts.length)

        for (let i = 0; i < this.refVerts.length; i++) {
            const refVert = this.refVerts[i]
            influenceMatrixArray[i] = new Array(this.refVerts.length)

            for (let j = 0; j < this.refVerts.length; j++) {
                const refVert2 = this.refVerts[j]

                if (i !== j) { //make sure vert doesnt use its own deformation as a reference
                    const influence = distance(refVert.position, refVert2.position)
                    influenceMatrixArray[i][j] = influence
                } else {
                    influenceMatrixArray[i][j] = 0 + 1e-6
                }
            }
        }

        console.log(influenceMatrixArray)

        const influenceMatrix = math.matrix(influenceMatrixArray)
        console.timeEnd("RBFDeformer.solve.influenceMatrixArray")

        console.time("RBFDeformer.solve.offsetMatrix")
        //create offset matrix VERT_COUNT x 3
        const offsetMatrixArrayX: number[] = new Array(this.refVerts.length)
        const offsetMatrixArrayY: number[] = new Array(this.refVerts.length)
        const offsetMatrixArrayZ: number[] = new Array(this.refVerts.length)
        for (let i = 0; i < this.refVerts.length; i++) {
            const refVert = this.refVerts[i]
            const distVert = this.distVerts[i]

            const offset = minus(distVert.position, refVert.position)

            offsetMatrixArrayX[i] = offset[0]
            offsetMatrixArrayY[i] = offset[1]
            offsetMatrixArrayZ[i] = offset[2]
        }
        console.log("A min/max", Math.min(...influenceMatrixArray[0]), Math.max(...influenceMatrixArray[0]));

        const offsetMatrixX = math.matrix(offsetMatrixArrayX)
        const offsetMatrixY = math.matrix(offsetMatrixArrayY)
        const offsetMatrixZ = math.matrix(offsetMatrixArrayZ)
        console.timeEnd("RBFDeformer.solve.offsetMatrix")

        console.time("RBFDeformer.solve.weights")
        //solve for weights
        const LU = math.lup(influenceMatrix)
        const weightMatrixX = math.lusolve(LU, offsetMatrixX)
        const weightMatrixY = math.lusolve(LU, offsetMatrixY)
        const weightMatrixZ = math.lusolve(LU, offsetMatrixZ)
        const weightArrayX = weightMatrixX.toArray().flat() as number[]
        const weightArrayY = weightMatrixY.toArray().flat() as number[]
        const weightArrayZ = weightMatrixZ.toArray().flat() as number[]
        console.log(weightMatrixX)
        console.log(weightArrayX)
        console.log(weightMatrixY)
        console.log(weightArrayY)
        console.log(weightMatrixZ)
        console.log(weightArrayZ)
        console.timeEnd("RBFDeformer.solve.weights")

        console.time("RBFDeformer.solve.weightsUnpack")
        this.weights = new Array(weightArrayX.length)
        for (let i = 0; i < weightArrayX.length; i++) {
            this.weights[i] = [weightArrayX[i], weightArrayY[i], weightArrayZ[i]]
        }
        console.timeEnd("RBFDeformer.solve.weightsUnpack")

        console.timeEnd("RBFDeformer.solve")
    }
    
    deform(vec: Vec3) {
        if (!this.weights) {
            throw new Error("RBF has not been solved")
        }

        let dx = 0
        let dy = 0
        let dz = 0

        for (let i = 0; i < this.refVerts.length; i++) {
            const vert = this.refVerts[i]

            const influence = distance(vec, vert.position)

            dx += influence * this.weights[i][0]
            dy += influence * this.weights[i][1]
            dz += influence * this.weights[i][2]
        }

        return add(vec, [dx,dy,dz])
    }

    deformMesh(mesh: FileMesh) {
        console.time("RBFDeformer.deformMesh")
        for (const vert of mesh.coreMesh.verts) {
            vert.position = this.deform(vert.position)
        }
        console.timeEnd("RBFDeformer.deformMesh")
    }
}

type Patch = {
    center: Vec3
    neighborIndices: number[]
    weights?: Float32Array // one weight per neighbor, thats 3 elements
}

let rbfDeformerIdCount = 0

export class RBFDeformerPatch {
    mesh: FileMesh

    refVerts: FileMeshVertex[] = [];
    distVerts: FileMeshVertex[] = [];

    importantIndices: number[] = [];

    controlKD: KDNode | null = null  // KD tree over refVerts
    patchKD: KDNode | null = null    // KD tree over patch centers

    patches: Patch[] = []

    patchCenters: Vec3[] = []

    nearestPatch: Uint16Array = new Uint16Array() //nearest patch for each vert in mesh

    K: number   // neighbors per patch
    patchCount: number    // how many patches you want
    epsilon: number = 1e-6; // avoid matrix from being singular
    affectBones: boolean = true

    id: number = rbfDeformerIdCount++

    constructor(refMesh: FileMesh, distMesh: FileMesh, mesh: FileMesh, ignoredIndices: number[] = [], patchCount = FLAGS.RBF_PATCH_COUNT, detailsCount = FLAGS.RBF_PATCH_DETAIL_SAMPLES, importantsCount = FLAGS.RBF_PATCH_SHAPE_SAMPLES) {
        //console.time(`RBFDeformerPatch.constructor.${this.id}`);
        this.mesh = mesh
        this.K = detailsCount
        
        //console.time(`RBFDeformerPatch.constructor.verts.${this.id}`);
        //get arrays of ref and dist verts that match in length and index
        const distVertArr = getDistVertArray(refMesh, distMesh)
        for (let i = 0; i < refMesh.coreMesh.verts.length; i++) {
            if (ignoredIndices.includes(i)) continue

            const distVert = distVertArr[i]
            if (distVert) {
                this.refVerts.push(refMesh.coreMesh.verts[i])
                this.distVerts.push(distVert)
            }
        }
        //console.log(refMesh.coreMesh.verts.length - this.refVerts.length)
        //console.timeEnd(`RBFDeformerPatch.constructor.verts.${this.id}`);

        //console.time(`RBFDeformerPatch.constructor.importants.${this.id}`);
        //add importants (verts added to every patch so the general mesh shape is always retained) also theyre picked kinda randomly
        const splitNeeded = Math.floor(this.refVerts.length / importantsCount)
        for (let i = 0; i < this.refVerts.length; i++) {
            if (i % splitNeeded === 0) {
                this.importantIndices.push(i)
            }
        }
        //console.timeEnd(`RBFDeformerPatch.constructor.importants.${this.id}`);

        //console.time(`RBFDeformerPatch.constructor.KD.${this.id}`);
        this.patchCount = patchCount

        const points: Vec3[] = new Array(this.refVerts.length)
        const indices = new Array(this.refVerts.length)
        for (let i = 0; i < this.refVerts.length; i++) {
            points[i] = this.refVerts[i].position
            indices[i] = i
        }

        this.controlKD = buildKDTree(points, indices)
        //console.timeEnd(`RBFDeformerPatch.constructor.KD.${this.id}`);

        //console.time(`RBFDeformerPatch.constructor.patches.${this.id}`);
        //create patches at kinda random positions
        const step = Math.max(1, Math.floor(this.refVerts.length / this.patchCount))
        const patchCenters: Vec3[] = []
        const patchCenterIndices: number[] = []

        for (let i = 0; i < this.refVerts.length; i += step) {
            patchCenters.push([...this.refVerts[i].position] as Vec3)
            patchCenterIndices.push(i)
            if (patchCenters.length >= this.patchCount) break
        }

        this.patchCenters = patchCenters
        //console.timeEnd(`RBFDeformerPatch.constructor.patches.${this.id}`);
        //console.timeEnd(`RBFDeformerPatch.constructor.${this.id}`);
    }

    async solveAsync() {
        //console.time(`RBFDeformerPatch.solve.${this.id}`);
        if (!this.controlKD) throw new Error("Control KD-tree not built")

        //console.time(`RBFDeformerPatch.solve.patches.${this.id}`);
        this.patches = new Array(this.patchCenters.length)

        //create each patch
        for (let p = 0; p < this.patchCenters.length; p++) {
            const centerPos = this.patchCenters[p]

            /*const K = neighbors.length
            if (K === 0) {
                console.log("K is 0")
                continue
            }*/

            this.patches[p] = {
                center: centerPos,
                neighborIndices: [],
                //weights,
            }
        }
        //console.timeEnd(`RBFDeformerPatch.solve.patches.${this.id}`);

        //console.time(`RBFDeformerPatch.solve.KDRebuild.${this.id}`);
        //build patch kd tree
        const patchPoints = this.patches.map(p => p.center)
        const patchIndices = patchPoints.map((_, i) => i)
        this.patchKD = buildKDTree(patchPoints, patchIndices)
        //console.timeEnd(`RBFDeformerPatch.solve.KDRebuild.${this.id}`);

        //console.time(`RBFDeformerPatch.solve.usedPatches.${this.id}`);
        //get used patches
        const isUsedArr = new Array(this.patches.length).fill(false)
        this.nearestPatch = new Uint16Array(this.mesh.coreMesh.verts.length + this.mesh.skinning.bones.length)

        for (let i = 0; i < this.mesh.coreMesh.verts.length; i++) {
            const vert = this.mesh.coreMesh.verts[i]
            const vec = vert.position

            //find nearest patch center
            const nearestPatchNode = nearestSearch(this.patchKD, vec)
            isUsedArr[nearestPatchNode.index] = true
            this.nearestPatch[i] = nearestPatchNode.index
        }

        for (let i = 0; i < this.mesh.skinning.bones.length; i++) {
            const bone = this.mesh.skinning.bones[i]
            const vec = bone.position

            //find nearest patch center
            const nearestPatchNode = nearestSearch(this.patchKD, vec)
            isUsedArr[nearestPatchNode.index] = true
            this.nearestPatch[i + this.mesh.coreMesh.verts.length] = nearestPatchNode.index
        }

        //console.timeEnd(`RBFDeformerPatch.solve.usedPatches.${this.id}`);

        //console.time(`RBFDeformerPatch.solve.patchNeighbors.${this.id}`);
        //get neighbors of used patches
        for (let i = 0; i < this.patches.length; i++) {
            if (!isUsedArr[i]) {
                continue
            }

            const patch = this.patches[i]
            const centerPos = patch.center

            //find nearest verts and add importants
            const neighbors = knnSearch(this.controlKD, centerPos, this.K)

            const neighborIndices = neighbors.map(n => n.index)
            for (const important of this.importantIndices) {
                if (!neighborIndices.includes(important)) {
                    neighborIndices.push(important)
                }
            }

            patch.neighborIndices = neighborIndices
        }
        //console.timeEnd(`RBFDeformerPatch.solve.patchNeighbors.${this.id}`);

        //create weights
        const weightPromises: (Promise<ArrayBuffer | undefined> | undefined)[] = new Array(this.patches.length)
        let totalSkipped = 0

        //console.time(`RBFDeformerPatch.solve.A.${this.id}`)
        const A_array: Float32Array[][] = new Array(this.patches.length)
        for (let p = 0; p < this.patches.length; p++) {
            const patch = this.patches[p]

            const neighborIndices = patch.neighborIndices
            const K = neighborIndices.length

            //pre-fetch positions
            const positions = new Array(neighborIndices.length) 
            for (let i = 0; i < neighborIndices.length; i++) {
                positions[i] = this.refVerts[neighborIndices[i]].position
            }

            //build distance matrix A
            const A: Float32Array[] = new Array(K)
            for (let i = 0; i < K; i++) {
                A[i] = new Float32Array(K)
            }
            for (let i = 0; i < K; i++) {
                const [pix, piy, piz] = positions[i]
                for (let j = i+1; j < K; j++) {
                    const [pjx, pjy, pjz] = positions[j]

                    const dist = Math.sqrt((pix - pjx)*(pix - pjx) + (piy - pjy)*(piy - pjy) + (piz - pjz)*(piz - pjz))

                    A[i][j] = dist
                    A[j][i] = dist
                }
                A[i][i] = this.epsilon
            }

            A_array[p] = A
        }
        //console.timeEnd(`RBFDeformerPatch.solve.A.${this.id}`)

        //console.time(`RBFDeformerPatch.solve.weightsPromise.${this.id}`);
        for (let p = 0; p < this.patches.length; p++) {
            //skip unused patches
            if (!isUsedArr[p]) {
                weightPromises[p] = undefined
                totalSkipped += 1
                continue
            }

            const patch = this.patches[p]

            const neighborIndices = patch.neighborIndices

            const K = neighborIndices.length
            //if (K === 0) continue

            const usedRef = new Array(K)
            const usedDist = new Array(K)

            for (let i = 0; i < K; i++) {
                const idx = neighborIndices[i]
                usedRef[i] = this.refVerts[idx]
                usedDist[i] = this.distVerts[idx]
            }

            const A = A_array[p]

            //create offset arrays
            const bx = new Float32Array(K)
            const by = new Float32Array(K)
            const bz = new Float32Array(K)

            for (let i = 0; i < K; i++) {
                const dr = usedDist[i].position
                const rr = usedRef[i].position

                bx[i] = dr[0] - rr[0]
                by[i] = dr[1] - rr[1]
                bz[i] = dr[2] - rr[2]
            }

            weightPromises[p] = WorkerPool.instance.work("patchRBF", [A.map(r => r.buffer), bx.buffer, by.buffer, bz.buffer]) as Promise<ArrayBuffer>
        }
        //console.timeEnd(`RBFDeformerPatch.solve.weightsPromise.${this.id}`);

        //wait for promises that return weights
        const weights = await Promise.all(weightPromises)
        for (let i = 0; i < weights.length; i++) {
            const weightArr = weights[i]
            if (weightArr) {
                this.patches[i].weights = new Float32Array(weightArr)
            }
        }

        console.log("skipped patches", totalSkipped)
        //console.timeEnd(`RBFDeformerPatch.solve.${this.id}`);
    }

    deform(i: number): Vec3 {
        if (!this.patchKD || this.patches.length === 0) {
            throw new Error("RBF has not been solved")
        }

        const vertLen = this.mesh.coreMesh.verts.length

        const vec = i < vertLen ? this.mesh.coreMesh.verts[i].position : this.mesh.skinning.bones[i - vertLen].position

        //find nearest patch center
        const patch = this.patches[this.nearestPatch[i]]

        const neighborIndices = patch.neighborIndices
        const weights = patch.weights

        if (!weights) {
            throw new Error("Patch is missing weights")
        }

        let dx = 0, dy = 0, dz = 0

        //use patch weights to deform
        for (let i = 0; i < neighborIndices.length; i++) {
            const refP = this.refVerts[neighborIndices[i]].position
            const r = distance(vec, refP)
            const phi = r // kernel

            dx += phi * weights[i*3 + 0]
            dy += phi * weights[i*3 + 1]
            dz += phi * weights[i*3 + 2]
        }

        return add(vec, [dx, dy, dz])
    }

    deformMesh() {
        console.time("RBFDeformerPatch.deformMesh");
        for (let i = 0; i < this.mesh.coreMesh.verts.length; i++) {
            const vert = this.mesh.coreMesh.verts[i]
            vert.position = this.deform(i)
        }

        if (this.affectBones) {
            for (let i = 0; i < this.mesh.skinning.bones.length; i++) {
                const bone = this.mesh.skinning.bones[i]
                bone.position = this.deform(this.mesh.coreMesh.verts.length + i)
            }
        }
        console.timeEnd("RBFDeformerPatch.deformMesh");
    }
}