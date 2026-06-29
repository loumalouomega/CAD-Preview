import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { orbit, pan, dolly, setDirection, viewDirection } from "./cameraControls";

function setup(): { camera: THREE.PerspectiveCamera; target: THREE.Vector3 } {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
  const target = new THREE.Vector3(0, 0, 0);
  camera.position.set(0, 0, 10);
  camera.lookAt(target);
  camera.updateMatrix();
  return { camera, target };
}

describe("cameraControls", () => {
  it("orbit changes the azimuth while keeping distance", () => {
    const { camera, target } = setup();
    const before = camera.position.distanceTo(target);
    const beforeTheta = new THREE.Spherical().setFromVector3(
      camera.position.clone().sub(target)
    ).theta;

    orbit(camera, target, 90, 0);

    const afterTheta = new THREE.Spherical().setFromVector3(
      camera.position.clone().sub(target)
    ).theta;
    expect(afterTheta).not.toBeCloseTo(beforeTheta);
    expect(camera.position.distanceTo(target)).toBeCloseTo(before);
  });

  it("orbit clamps the polar angle to avoid flipping over the poles", () => {
    const { camera, target } = setup();
    orbit(camera, target, 0, 1000); // far past the north pole
    const phi = new THREE.Spherical().setFromVector3(
      camera.position.clone().sub(target)
    ).phi;
    expect(phi).toBeGreaterThan(0);
    expect(phi).toBeLessThan(Math.PI);
  });

  it("dolly with factor < 1 moves the camera closer to the target", () => {
    const { camera, target } = setup();
    const before = camera.position.distanceTo(target);
    dolly(camera, target, 0.8);
    expect(camera.position.distanceTo(target)).toBeCloseTo(before * 0.8);
  });

  it("pan shifts both the camera and the target by the same delta", () => {
    const { camera, target } = setup();
    const camBefore = camera.position.clone();
    const targetBefore = target.clone();

    pan(camera, target, 0.15, 0);

    const camDelta = camera.position.clone().sub(camBefore);
    const targetDelta = target.clone().sub(targetBefore);
    expect(targetDelta.length()).toBeGreaterThan(0);
    expect(camDelta.distanceTo(targetDelta)).toBeCloseTo(0);
  });

  it("setDirection points the camera along the requested axis", () => {
    const { camera, target } = setup();
    const distance = camera.position.distanceTo(target);
    setDirection(camera, target, new THREE.Vector3(0, 1, 0));
    expect(camera.position.x).toBeCloseTo(0);
    expect(camera.position.y).toBeCloseTo(distance);
    expect(camera.position.z).toBeCloseTo(0);
  });

  it("viewDirection returns the normalized target-to-camera direction", () => {
    const { camera, target } = setup();
    const dir = viewDirection(camera, target);
    expect(dir.length()).toBeCloseTo(1);
    expect(dir.z).toBeCloseTo(1);
  });
});
