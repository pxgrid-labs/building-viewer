import * as THREE from 'three';
import { Timer } from 'three';
import CameraControls from 'camera-controls';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

CameraControls.install( { THREE: THREE } );

const canvas = document.getElementById( 'app' );
const loadingEl = document.getElementById( 'loading' );

// Renderer
const renderer = new THREE.WebGLRenderer( { canvas: canvas, antialias: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color( 0x1a1a1f );

// Image-based lighting for PBR (baseColor + metallicRoughness + normal).
// Equirectangular HDR panorama (public/env.ktx2, Poly Haven "kloofendal_48d_partly_cloudy_puresky", CC0) → PMREM.
const pmremGenerator = new THREE.PMREMGenerator( renderer );

// A key light to give the surfaces some direction
const keyLight = new THREE.DirectionalLight( 0xffffff, 2.0 );
keyLight.position.set( 5, 10, 7.5 );
scene.add( keyLight );

// Camera
const camera = new THREE.PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 1, 1000 );
camera.position.set( 0, 0, 5 );

// Camera controls
const DISTANCE_MIN = 1;
const DISTANCE_MAX = 400;

const timer = new Timer();
const controls = new CameraControls( camera, canvas );
controls.minDistance = DISTANCE_MIN;
controls.maxDistance = DISTANCE_MAX;

// Disable panning (truck): keep only orbit + dolly on mouse and touch.
controls.mouseButtons.right = CameraControls.ACTION.NONE;
controls.touches.two = CameraControls.ACTION.TOUCH_DOLLY;
controls.touches.three = CameraControls.ACTION.NONE;

// Loaders
const manager = new THREE.LoadingManager();
manager.onProgress = ( url, loaded, total ) => {

	const pct = total > 0 ? Math.round( ( loaded / total ) * 100 ) : 0;
	loadingEl.textContent = `Loading… ${ pct }%`;

};

const dracoLoader = new DRACOLoader( manager );
// three 同梱のデコーダを import.meta.url で参照 → Vite が自動バンドル（CDN も public コピーも不要）。
dracoLoader.setDecoderPath( DRACO_GLTF_CONFIG );

const gltfLoader = new GLTFLoader( manager );
gltfLoader.setDRACOLoader( dracoLoader );

// Load the HDR panorama (UASTC HDR .ktx2, transcoded to BC6H) and turn it into a prefiltered IBL environment.
// KTX2Loader needs the basis transcoder; it has no import.meta.url config like DRACO, so the files live in public/basis/.
const ktx2Loader = new KTX2Loader( manager );
ktx2Loader.setTranscoderPath( `${ import.meta.env.BASE_URL }basis/` );
ktx2Loader.detectSupport( renderer );

ktx2Loader.load( `${ import.meta.env.BASE_URL }env.ktx2`, ( texture ) => {

	texture.mapping = THREE.EquirectangularReflectionMapping; // linear HDR data — no sRGB conversion

	// IBL: prefilter the panorama for PBR reflections.
	scene.environment = pmremGenerator.fromEquirectangular( texture ).texture;

	// Background: reuse the prefiltered environment. three's equirect→cube conversion for the
	// background produces a black sky from a compressed (BC6H) source, whereas PMREM reads it fine.
	scene.background = scene.environment;

	pmremGenerator.dispose();
	ktx2Loader.dispose();
	texture.dispose();

} );

// Camera presets, computed from the model's bounding box after loading.
// Compass convention: +X = East, -X = West, +Z = South, -Z = North.
let presets = null;
let modelBox = null;

const DEG90 = Math.PI / 2;

// Each preset is a function ( enableTransition ) => Promise that drives camera-controls directly and
// resolves once the move rests. Only the facades share real logic (rotate square-on → fitToBox), so they
// alone are worth unifying; the rest just call the method that fits their framing.
function buildPresets( box ) {

	const center = box.getCenter( new THREE.Vector3() );
	const size = box.getSize( new THREE.Vector3() );

	// Distance needed to frame the full building height in the vertical FOV.
	const halfFovY = THREE.MathUtils.degToRad( camera.fov / 2 );
	const faceDist = ( size.y / 2 ) / Math.tan( halfFovY ) * 1.15;

	// Overview is pulled back a bit further so the building keeps top/bottom margin.
	const overviewDist = faceDist * 1.28;

	// Even world-unit padding around each facade when fitting.
	const pad = size.y * 0.05;
	const facePadding = { paddingLeft: pad * .8, paddingRight: pad, paddingTop: pad, paddingBottom: pad * 1.2 };

	const cx = center.x;
	const cy = center.y;
	const cz = center.z;

	// A point in front of the +Z (south) entrance facade, at roughly eye height.
	const ex = cx;
	const ey = box.min.y + 2;
	const ez = box.max.z + 5;

	// normalizeRotations() after each *To call snaps the accumulated azimuth to the target's nearest
	// equivalent, so every transition takes the shortest path (never spins more than 180deg).

	// Wide 3/4 framing — an explicit camera + target reads clearest here.
	const lookAt = ( px, py, pz, tx, ty, tz ) => ( enableTransition ) => {

		const rest = controls.setLookAt( px, py, pz, tx, ty, tz, enableTransition );
		controls.normalizeRotations();
		return rest;

	};

	// Close, first-person framings — aim at a target, pick an orbit angle, keep the distance small.
	// (Easier to reason about than a separate camera position that has to be kept in sync with the target.)
	// These are the "FPS" presets: the target sits right in front of the camera, so dragging should feel
	// like looking around (mouselook) rather than orbiting an object — moveTo inverts the drag for them.
	const orbit = ( tx, ty, tz, azimuth, polar, distance ) => {

		const move = ( enableTransition ) => {

			controls.setTarget( tx, ty, tz, enableTransition );
			controls.dollyTo( distance, enableTransition );
			const rest = controls.rotateTo( azimuth, polar, enableTransition );
			controls.normalizeRotations();
			return rest;

		};

		move.fps = true;
		return move;

	};

	// Facades — turn square-on (horizontal), then fit the whole side with padding.
	// Compass: +X = East, -X = West, +Z = South, -Z = North. azimuth 0 looks from +Z.
	const face = ( azimuth ) => ( enableTransition ) => {

		controls.rotateTo( azimuth, DEG90, enableTransition );
		controls.normalizeRotations();
		return controls.fitToBox( box, enableTransition, facePadding );

	};

	return {
		overview: lookAt( cx + overviewDist * 0.34, cy + size.y * 0.3, cz + overviewDist * 0.82, cx, cy, cz ),
		// Look level at the facade from up close.
		entrance: orbit( ex, ey, ez, 0, 100 * THREE.MathUtils.DEG2RAD, 0 ),
		// Same spot, aim high so the camera pitches up the tower (worm's-eye). The large polar drops the
		// camera below the aim point; the distance keeps it above ground.
		lookup: orbit( ex + 5, ey, ez, 20 * THREE.MathUtils.DEG2RAD, 150 * THREE.MathUtils.DEG2RAD, 0 ),
		east:  face( DEG90 ),
		south: face( 0 ),
		west:  face( -DEG90 ),
		north: face( Math.PI ),
	};

}

// Guards the distance-lock against rapid preset switches: only the latest move locks.
let moveToken = 0;
const _target = new THREE.Vector3();
const _sphere = new THREE.Sphere();

async function moveTo( view, enableTransition = true ) {

	if ( presets === null ) return;

	const preset = presets[ view ];
	if ( preset === undefined ) return;

	// Release the distance / polar locks so the transition can re-frame freely.
	controls.minDistance = DISTANCE_MIN;
	controls.maxDistance = DISTANCE_MAX;
	controls.maxPolarAngle = Math.PI;

	// FPS presets look outward from a nearby target, so invert the drag (up/down and left/right) to
	// give a mouselook feel; orbit presets keep the normal object-orbiting direction.
	const rotateSpeed = preset.fps === true ? - .2 : 1;
	controls.azimuthRotateSpeed = rotateSpeed;
	controls.polarRotateSpeed = rotateSpeed;

	const token = ++ moveToken;

	// Reflect the active view in the menu (immediately, before the transition finishes).
	for ( const button of menuList.querySelectorAll( 'button' ) ) {

		button.classList.toggle( 'active', button.dataset.view === view );

	}

	// Run the preset — it calls camera-controls directly and resolves when the move settles.
	await preset( enableTransition );

	if ( token !== moveToken ) return; // a newer move superseded this one

	const distance = controls.distance;

	if ( preset.fps === true ) {

		// FPS: lock the distance and look around freely (no polar limit, including up past vertical).
		controls.minDistance = controls.maxDistance = distance;

	} else {

		// Non-FPS: loosen the distance lock — allow dollying in toward the building (down to its
		// bounding-sphere radius) and back out to the framed distance.
		modelBox.getBoundingSphere( _sphere );
		controls.minDistance = Math.min( _sphere.radius, distance );
		controls.maxDistance = distance;

		// Keep the camera from orbiting below ground (y = 0), which would reveal the building's underside.
		// camera.y = target.y + distance * cos( polar ), so camera.y >= 0 ⟺ polar <= acos( -target.y / distance ).
		controls.getTarget( _target );
		controls.maxPolarAngle = Math.acos( THREE.MathUtils.clamp( - _target.y / distance, - 1, 1 ) );

	}

}

// Grass-colored ground plane sitting at the building's base.
function addGround( box ) {

	const ground = new THREE.Mesh(
		new THREE.CircleGeometry( 200, 96 ),
		new THREE.MeshStandardMaterial( { color: 0x8faa63, roughness: 1, metalness: 0 } )
	);
	ground.rotation.x = - DEG90;
	ground.position.y = box.min.y - 0.02; // a hair below the model base to avoid z-fighting
	scene.add( ground );

}

// Positions for a ring of trees just outside the building footprint.
// Compass: +X = East, -X = West, +Z = South (entrance), -Z = North.
function treePositions( box ) {

	const positions = [];

	const margin = 8;
	const x0 = box.min.x - margin;
	const x1 = box.max.x + margin;
	const z0 = box.min.z - margin;
	const z1 = box.max.z + margin;

	const step = 7;
	const entranceCenterX = ( box.min.x + box.max.x ) / 2;
	const entranceGap = 8; // keep a clear path in front of the +Z (south) entrance

	// North (-Z) and South (+Z) edges: distribute along X.
	for ( let x = x0; x <= x1 + 0.001; x += step ) {

		positions.push( [ x, z0 ] );

		if ( Math.abs( x - entranceCenterX ) > entranceGap ) {

			positions.push( [ x, z1 ] );

		}

	}

	// East (+X) and West (-X) edges: distribute along Z (skip the corners already placed).
	for ( let z = z0 + step; z <= z1 - step + 0.001; z += step ) {

		positions.push( [ x1, z ] );
		positions.push( [ x0, z ] );

	}

	return positions;

}

// Load the tree once, then clone it around the building perimeter.
function scatterTrees( box ) {

	gltfLoader.load(

		`${ import.meta.env.BASE_URL }tree.glb`,
		( gltf ) => {

			const tree = gltf.scene;
			const baseY = box.min.y;

			for ( const [ x, z ] of treePositions( box ) ) {

				const instance = tree.clone();
				// Small jitter only, so the ring reads as a tidy row rather than scattered.
				instance.position.set(
					x + ( Math.random() - 0.5 ) * 0.8,
					baseY,
					z + ( Math.random() - 0.5 ) * 0.8
				);
				// Vary the facing for a bit of life, but keep the size nearly uniform.
				instance.rotation.y = Math.random() * Math.PI * 2;
				instance.scale.setScalar( 0.95 + Math.random() * 0.15 );
				scene.add( instance );

			}

		},
		undefined,
		( error ) => console.error( error )

	);

}

gltfLoader.load(

	`${ import.meta.env.BASE_URL }building.draco.glb`,
	( gltf ) => {

		const model = gltf.scene;
		scene.add( model );

		modelBox = new THREE.Box3().setFromObject( model );
		presets = buildPresets( modelBox );

		addGround( modelBox );
		scatterTrees( modelBox );

		moveTo( 'overview', false );

		loadingEl.classList.add( 'hidden' );

	},
	undefined,
	( error ) => {

		console.error( error );
		loadingEl.textContent = 'Failed to load model.';

	}

);

// Menu
const menuToggle = document.getElementById( 'menu-toggle' );
const menuList = document.getElementById( 'menu-list' );

menuToggle.addEventListener( 'click', () => {

	const open = menuList.hasAttribute( 'hidden' );

	if ( open ) {

		menuList.removeAttribute( 'hidden' );

	} else {

		menuList.setAttribute( 'hidden', '' );

	}

	menuToggle.setAttribute( 'aria-expanded', String( open ) );

} );

menuList.addEventListener( 'click', ( event ) => {

	const button = event.target.closest( 'button[data-view]' );
	if ( button === null ) return;

	moveTo( button.dataset.view, true );

} );

// Resize
window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );

// Render loop
function animate() {

	timer.update();
	const delta = timer.getDelta();
	controls.update( delta );

	renderer.render( scene, camera );
	requestAnimationFrame( animate );

}

animate();
