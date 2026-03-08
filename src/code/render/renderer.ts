import * as THREE from 'three';
import { EffectComposer, OrbitControls, OutputPass, RenderPass, UnrealBloomPass } from 'three/examples/jsm/Addons.js';
import { download, rad, saveByteArray } from '../misc/misc';
import type { RenderDesc } from './renderDesc';
import { ObjectDesc } from './objectDesc';
import { type Connection, type Instance } from '../rblx/rbx';
import type { Authentication } from '../api';
import { EmitterGroupDescClassTypes, ObjectDescClassTypes } from '../rblx/constant';
import { GLTFExporter } from 'three/examples/jsm/Addons.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { EmitterGroupDesc } from './emitterGroupDesc';
import { FLAGS } from '../misc/flags';
import type { Vec3 } from '../mesh/mesh';
import { loadCompositMeshes } from './textureComposer';

export class RBXRenderer {
    static isRenderingMesh: Map<Instance,boolean> = new Map()
    static renderDescs: Map<Instance,RenderDesc> = new Map()
    static destroyConnections: Map<Instance,Connection> = new Map()

    static lookAwayVector: Vec3 = [0.406, 0.306, -0.819]
    static lookAwayDistance: number = 6

    static orbitControlsTarget: Vec3 = [0,3,0]

    static scene: THREE.Scene = new THREE.Scene()
    static camera: THREE.PerspectiveCamera = new THREE.PerspectiveCamera( 70, 1 / 1, 0.1, 100 );
    static controls: OrbitControls | undefined

    static renderer: THREE.WebGLRenderer = new THREE.WebGLRenderer({antialias: true})
    static effectComposer: EffectComposer | undefined

    static resolution: [number,number] = [420, 420]

    /**Fully sets up renderer with scene, camera and frame rendering*/
    static fullSetup() {
        loadCompositMeshes()
        RBXRenderer.create()
        RBXRenderer.setupScene()
        RBXRenderer.setupControls()
        RBXRenderer.animate()
    }

    /**Sets up the THREE.js renderer */
    static create() {
        RBXRenderer.renderer.setClearColor(new THREE.Color(1,0,1), 0)

        RBXRenderer.renderer.outputColorSpace = THREE.SRGBColorSpace
        RBXRenderer.renderer.shadowMap.enabled = true
        RBXRenderer.renderer.shadowMap.type = THREE.PCFSoftShadowMap

        RBXRenderer.renderer.setPixelRatio(window.devicePixelRatio * 1)
        RBXRenderer.renderer.setSize(...RBXRenderer.resolution);

        if (FLAGS.USE_POST_PROCESSING && FLAGS.POST_PROCESSING_IS_DOUBLE_SIZE) {
            RBXRenderer.renderer.setSize(RBXRenderer.resolution[0] * 2, RBXRenderer.resolution[1] * 2)
        }

        RBXRenderer.renderer.domElement.setAttribute("style",`width: ${RBXRenderer.resolution[0]}px; height: ${RBXRenderer.resolution[1]}px; border-radius: 0px;`)
        RBXRenderer.renderer.domElement.setAttribute("id","OutfitInfo-outfit-image-3d")

        if (FLAGS.USE_POST_PROCESSING) {
            RBXRenderer._createEffectComposer()
        }
    }

    /**Sets up a basic scene with lighting
     * @param lightingType "WellLit" is the default lighting for RoAvatar, "Thumbnail" tries to match the Roblox thumbnail lighting
    */
    static setupScene(lightingType: "WellLit" | "Thumbnail" = "WellLit") {
        //const backgroundColor = new THREE.Color( 0x2C2E31 )
        //const backgroundColor = new THREE.Color( 0x191a1f )
        //const backgroundColor = new THREE.Color( 0x2a2a2d )
        const backgroundColor = new THREE.Color( 0x2b2d33 )
        RBXRenderer.scene.background = backgroundColor;

        let thumbnailAmbientVal = 138 //138 SHOULD be accurate but its not???, nvm it probably is but there is a second light source, wait i think ambient is more correct to use
        thumbnailAmbientVal = 128
        //thumbnailAmbientVal = 153 //this is 255 * 0.6
        let ambientLightColor = undefined
        if (lightingType === "Thumbnail") {
            ambientLightColor = new THREE.Color(thumbnailAmbientVal / 255, thumbnailAmbientVal / 255, thumbnailAmbientVal / 255)
        } else if (lightingType === "WellLit") {
            ambientLightColor = new THREE.Color(100 / 255, 100 / 255, 100 / 255)
        }
        //const ambientLight = new THREE.AmbientLight( 0x7a7a7a );
        const ambientLight = new THREE.AmbientLight( ambientLightColor, Math.PI / 2 );
        RBXRenderer.scene.add( ambientLight );

        let directionalLightColor = undefined
        const directionalLightVal = 0.7 * 0.9 * 2 * 0.4
        if (lightingType === "Thumbnail") {
            directionalLightColor = new THREE.Color(directionalLightVal, directionalLightVal, directionalLightVal)
        } else if (lightingType === "WellLit") {
            directionalLightColor = new THREE.Color(1,1,1)
        }
        let directionalLightIntensity = 1
        if (lightingType === "WellLit") {
            directionalLightIntensity = Math.PI / 2
        }

        const directionalLight = new THREE.DirectionalLight( directionalLightColor, directionalLightIntensity );
        //directionalLight.position.set(new THREE.Vector3(1.2,1,1.2))
        if (lightingType === "WellLit") {
            directionalLight.position.set(-5,15,-8)
        } else if (lightingType === "Thumbnail") {
            directionalLight.position.set(-0.47489210963249207 * 10, 0.8225368857383728 * 10, 0.3129066228866577 * 10)
        }

        if (lightingType === "WellLit") {
            directionalLight.castShadow = true
        }
        directionalLight.shadow.mapSize.width = 256;
        directionalLight.shadow.mapSize.height = 256;

        const bottomOffset = 1.6
        const shadowPhysicalSize = 5
        directionalLight.shadow.camera.left = -shadowPhysicalSize
        directionalLight.shadow.camera.right = shadowPhysicalSize
        directionalLight.shadow.camera.top = shadowPhysicalSize + bottomOffset
        directionalLight.shadow.camera.bottom = -shadowPhysicalSize + bottomOffset

        directionalLight.shadow.camera.near = 0.5; // default
        directionalLight.shadow.camera.far = 25;

        directionalLight.shadow.intensity = 0.5

        //const shadowHelper = new THREE.CameraHelper(directionalLight.shadow.camera);
        //scene.add(shadowHelper);

        directionalLight.target.position.set(0,0,0)
        RBXRenderer.scene.add( directionalLight );

        if (lightingType === "WellLit") {
            const directionalLight2 = new THREE.DirectionalLight( 0xffffff, 0.3 );
            //directionalLight.position.set(new THREE.Vector3(1.2,1,1.2))
            directionalLight2.position.set(5,-7,5)
            directionalLight2.target.position.set(0,0,0)
            RBXRenderer.scene.add( directionalLight2 );
        } else if (lightingType === "Thumbnail") { //this looks good TODO: disable specular from this light somehow, should exclusively be diffuse
            const directionalLight2 = new THREE.DirectionalLight( directionalLightColor, directionalLightIntensity * 0.5 );
            //directionalLight.position.set(new THREE.Vector3(1.2,1,1.2))
            directionalLight2.position.set(-0.47489210963249207 * -10, 0.8225368857383728 * -10, 0.3129066228866577 * -10)
            directionalLight2.target.position.set(0,0,0)
            RBXRenderer.scene.add( directionalLight2 );
        }

        const planeGeometry = new THREE.PlaneGeometry( 100, 100, 1, 1 );
        const planeShadowMaterial = new THREE.ShadowMaterial({opacity: 1.0});
        const shadowPlane = new THREE.Mesh( planeGeometry, planeShadowMaterial );
        shadowPlane.rotation.set(rad(-90),0,0)
        shadowPlane.position.set(0,0,0)
        shadowPlane.receiveShadow = true;
        RBXRenderer.scene.add( shadowPlane );

        const planeSolidColorMaterial = new THREE.MeshBasicMaterial({color: backgroundColor})
        const plane = new THREE.Mesh( planeGeometry, planeSolidColorMaterial );
        plane.rotation.set(rad(-90),0,0)
        plane.position.set(0,0,0)
        plane.receiveShadow = false;
        RBXRenderer.scene.add( plane );
    }

    /**Sets up orbit controls */
    static setupControls() {
        //orbit controls
        const controls = new OrbitControls(RBXRenderer.camera, RBXRenderer.renderer.domElement)
        controls.maxDistance = 25
        controls.zoomSpeed = 2

        controls.target.set(...RBXRenderer.orbitControlsTarget)
        console.log(controls.target)

        RBXRenderer.controls = controls
        RBXRenderer.camera.position.set(RBXRenderer.lookAwayVector[0] * RBXRenderer.lookAwayDistance,3 + RBXRenderer.lookAwayVector[1] * RBXRenderer.lookAwayDistance,RBXRenderer.lookAwayVector[2] * RBXRenderer.lookAwayDistance)
        RBXRenderer.camera.lookAt(new THREE.Vector3(...RBXRenderer.orbitControlsTarget))
        controls.update()
    }

    /**Makes the renderer render a new frame on every animationFrame */
    static animate() {
        RBXRenderer.renderer.setRenderTarget(null)
        if (RBXRenderer.effectComposer) {
            RBXRenderer.effectComposer.render();
        } else {
            RBXRenderer.renderer.render(RBXRenderer.scene, RBXRenderer.camera)
        }

        requestAnimationFrame( () => {
            RBXRenderer.animate()
        } );
    }

    static _createEffectComposer() {
        RBXRenderer.effectComposer = new EffectComposer(RBXRenderer.renderer)
        const renderPass = new RenderPass(RBXRenderer.scene, RBXRenderer.camera)
        RBXRenderer.effectComposer.addPass(renderPass)

        const resolution = new THREE.Vector2(420, 420)
        const bloomPass = new UnrealBloomPass(resolution, 0.15, 0.0001, 0.9)
        RBXRenderer.effectComposer.addPass(bloomPass)

        if (!FLAGS.POST_PROCESSING_IS_DOUBLE_SIZE) {
            const fxaaPass = new FXAAPass()
            RBXRenderer.effectComposer.addPass(fxaaPass)
        }

        const outputPass = new OutputPass()
        RBXRenderer.effectComposer.addPass(outputPass)
    }

    /**Removes an instance from the renderer */
    static removeInstance(instance: Instance) {
        console.log("Removed instance:", instance.Prop("Name"), instance.id)

        const desc = RBXRenderer.renderDescs.get(instance)
        if (desc) {
            desc.dispose(RBXRenderer.renderer, RBXRenderer.scene)
        }

        RBXRenderer.renderDescs.delete(instance)
        RBXRenderer.isRenderingMesh.delete(instance)

        for (const child of instance.GetChildren()) {
            RBXRenderer.removeInstance(child)
        }
    }

    static _addRenderDesc(instance: Instance, auth: Authentication, DescClass: typeof RenderDesc) {
        const oldDesc = RBXRenderer.renderDescs.get(instance)
        const newDesc = new DescClass()
        newDesc.fromInstance(instance)

        if (oldDesc && !oldDesc.needsRegeneration(newDesc)) {
            //do nothing except update
            //console.log(`Updating ${instance.Prop("Name")}`)
            if (!oldDesc.isSame(newDesc)) {
                oldDesc.fromRenderDesc(newDesc)
                oldDesc.updateResults()
            }
        } else {
            //generate new mesh
            if (!RBXRenderer.isRenderingMesh.get(instance)) {
                //console.log(`Generating ${instance.Prop("Name")} ${instance.id}`)

                newDesc.results = oldDesc?.results //this is done so that the result can be disposed if a removeInstance is called during generation
                RBXRenderer.renderDescs.set(instance, newDesc)
                RBXRenderer.isRenderingMesh.set(instance, true)

                //get the mesh
                newDesc.compileResults(RBXRenderer.renderer, RBXRenderer.scene).then(results => {
                    if (results && !(results instanceof Response)) {
                        newDesc.updateResults()

                        if (RBXRenderer.renderDescs.get(instance)) {
                            oldDesc?.dispose(RBXRenderer.renderer, RBXRenderer.scene)

                            for (const result of results) {
                                //update skeletonDesc for RenderDescs that have that
                                if (result instanceof THREE.SkinnedMesh && newDesc instanceof ObjectDesc) {
                                    const skeleton = newDesc.skeletonDesc?.skeleton
                                    
                                    if (skeleton) {
                                        result.bindMode = "detached"
                                        if (newDesc.skeletonDesc) {
                                            RBXRenderer.scene.add(newDesc.skeletonDesc.rootBone)
                                        }
                                        result.bind(skeleton)
                                        RBXRenderer.scene.add(result)
                                    }
                                } else {
                                    RBXRenderer.scene.add(result)
                                }
                            }

                            //console.log(`Generated ${instance.Prop("Name")} ${instance.id}`)

                            RBXRenderer.isRenderingMesh.set(instance, false)
                            RBXRenderer.addInstance(instance, auth) //check instance again in case it changed during compilation
                        } else {
                            newDesc.dispose(RBXRenderer.renderer, RBXRenderer.scene)
                        }
                    } else {
                        console.warn("Failed to compile mesh", results)
                    }
                })
            }
        }

        if (!RBXRenderer.destroyConnections.get(instance)) {
            RBXRenderer.destroyConnections.set(instance, instance.Destroying.Connect(() => {
                RBXRenderer.removeInstance(instance)
                const connection = RBXRenderer.destroyConnections.get(instance)
                connection?.Disconnect()
                RBXRenderer.destroyConnections.delete(instance)
            }))
        }
    }

    /**Adds an instance to the renderer or updates it */
    static addInstance(instance: Instance, auth: Authentication) {
        //check that this decal isnt baked and should get its own ObjectDesc
        const isDecal = instance.className === "Decal"
        const isBakedDecal = isDecal && !instance.FindFirstChildOfClass("WrapTextureTransfer")
        let isFirstDecal = true
        if (isDecal && instance.parent) {
            const children = instance.GetChildren()
            for (const child of children) {
                if (child.className === "Decal" && child.FindFirstChildOfClass("WrapTextureTransfer") && child.id < instance.id) {
                    isFirstDecal = false
                }
            }
        }

        //ObjectDesc
        if (ObjectDescClassTypes.includes(instance.className) && !isBakedDecal && (!isDecal || isFirstDecal)) {
            RBXRenderer._addRenderDesc(instance, auth, ObjectDesc)
        }
        //EmitterGroupDesc
        else if (EmitterGroupDescClassTypes.includes(instance.className)) {
            RBXRenderer._addRenderDesc(instance, auth, EmitterGroupDesc)
        }

        //update children  too
        for (const child of instance.GetChildren()) {
            RBXRenderer.addInstance(child, auth)
        }
    }

    static setRendererSize(width: number, height: number) {
        RBXRenderer.renderer.setSize(width, height)
    }

    static getRendererDom() {
        return RBXRenderer.renderer.domElement
    }

    static getRendererCamera() {
        return RBXRenderer.camera
    }

    static getRendererControls() {
        return RBXRenderer.controls
    }

    static getRenderer() {
        return RBXRenderer.renderer
    }

    static getScene() {
        return RBXRenderer.scene
    }

    /**@deprecated
     * This function is unstable and can throw errors, but might work
     */
    static exportScene() {
        const exporter = new GLTFExporter()
        exporter.parse(RBXRenderer.scene, (gltf) => {
            if (gltf instanceof ArrayBuffer) {
                saveByteArray([gltf], "scene.glb")
            } else {
                download("scene.gltf",JSON.stringify(gltf))
            }
        }, (error) => {
            throw error
        })
    }
}

export function mount( container: HTMLDivElement ) {
    if (container) {
        container.insertBefore(RBXRenderer.renderer.domElement, container.firstChild)
    } else {
        RBXRenderer.renderer.domElement.remove()
    }
}