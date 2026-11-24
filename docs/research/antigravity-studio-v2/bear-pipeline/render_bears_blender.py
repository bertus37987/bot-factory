import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector, Euler
from bpy_extras.object_utils import world_to_camera_view


def set_input(node, names, val):
    for n in names:
        if n in node.inputs:
            node.inputs[n].default_value = val
            return True
    return False


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def configure_render(samples=32, res=512):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 3
    scene.cycles.glossy_bounces = 3
    scene.cycles.transparent_max_bounces = 6

    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"

    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium Contrast"
    except Exception:
        try:
            scene.view_settings.view_transform = "Filmic"
        except Exception:
            pass
    scene.view_settings.exposure = 0.35

    world = bpy.data.worlds.new("StudioWorld")
    scene.world = world
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.05, 0.042, 0.036, 1.0)
        bg.inputs[1].default_value = 1.0


def make_velvet_fur_mat(name, base_rgb, sheen_rgb=(0.95, 0.78, 0.60), roughness=0.84, bump_strength=0.04, scale=95.0):
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    tex_coord = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    bump = nt.nodes.new("ShaderNodeBump")

    set_input(bsdf, ["Base Color"], (*base_rgb, 1.0))
    set_input(bsdf, ["Roughness"], roughness)
    set_input(bsdf, ["Sheen Weight", "Sheen"], 0.92)
    set_input(bsdf, ["Sheen Roughness"], 0.42)
    set_input(bsdf, ["Sheen Tint"], (*sheen_rgb, 1.0))
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.18)

    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 8.0
    noise.inputs["Roughness"].default_value = 0.65
    bump.inputs["Strength"].default_value = bump_strength
    bump.inputs["Distance"].default_value = 0.014

    nt.links.new(tex_coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def make_metal_mat(name, base_rgb, metallic=0.92, roughness=0.20):
    mat = bpy.data.materials.new(name)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    set_input(bsdf, ["Base Color"], (*base_rgb, 1.0))
    set_input(bsdf, ["Metallic"], metallic)
    set_input(bsdf, ["Roughness"], roughness)
    return mat


def make_satin_mat(name, base_rgb, roughness=0.24, emission_rgb=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    set_input(bsdf, ["Base Color"], (*base_rgb, 1.0))
    set_input(bsdf, ["Roughness"], roughness)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.68)
    if emission_rgb and emission_strength > 0:
        set_input(bsdf, ["Emission Color", "Emission"], (*emission_rgb, 1.0))
        set_input(bsdf, ["Emission Strength"], emission_strength)
    return mat


def add_lowpoly_plush_sphere(name, location, scale, mat, subdivisions=2, bevel_width=0.055):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1.0)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = Vector(location)
    obj.scale = Vector(scale)
    obj.data.materials.append(mat)
    # Soft-bevel + auto smooth facets keep low-poly semi-3D silhouette with velvety touch
    bev = obj.modifiers.new("Bevel", "BEVEL")
    bev.width = bevel_width
    bev.segments = 2
    bev.limit_method = "NONE"
    for p in obj.data.polygons:
        p.use_smooth = False
    return obj


def add_uv_sphere(name, location, scale, mat, segs=32, rings=20, smooth=True):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = Vector(location)
    obj.scale = Vector(scale)
    obj.data.materials.append(mat)
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    return obj


def add_torus(name, location, rotation_deg, major_r, minor_r, mat, maj_seg=48, min_seg=18, arc_deg=360.0):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    steps = max(8, int(round(maj_seg * (arc_deg / 360.0))))
    arc_rad = math.radians(arc_deg)
    rings = []
    for i in range(steps + (0 if arc_deg >= 359.9 else 1)):
        theta = (i / steps) * arc_rad if arc_deg < 359.9 else (i / maj_seg) * 2.0 * math.pi
        cx = math.cos(theta) * major_r
        cy = math.sin(theta) * major_r
        nx = math.cos(theta)
        ny = math.sin(theta)
        ring = []
        for j in range(min_seg):
            phi = (j / min_seg) * 2.0 * math.pi
            px = cx + nx * (math.cos(phi) * minor_r)
            py = cy + ny * (math.cos(phi) * minor_r)
            pz = math.sin(phi) * minor_r
            ring.append(bm.verts.new((px, py, pz)))
        rings.append(ring)

    count = len(rings)
    closed = arc_deg >= 359.9
    end = count if closed else count - 1
    for i in range(end):
        r1 = rings[i]
        r2 = rings[(i + 1) % count]
        for j in range(min_seg):
            j2 = (j + 1) % min_seg
            bm.faces.new((r1[j], r2[j], r2[j2], r1[j2]))
    if not closed:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = Vector(location)
    obj.rotation_euler = Euler([math.radians(a) for a in rotation_deg], "XYZ")
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def add_cylinder(name, p0, p1, r0, r1, mat, segs=18):
    v0 = Vector(p0)
    v1 = Vector(p1)
    diff = v1 - v0
    length = diff.length
    mid = (v0 + v1) * 0.5
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r0, radius2=r1, depth=length)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = mid
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = diff.normalized().to_track_quat("Z", "Y")
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def add_area_light(name, location, look_at, energy, size, color=(1.0, 1.0, 1.0)):
    ldata = bpy.data.lights.new(name=name, type="AREA")
    ldata.energy = energy
    ldata.size = size
    ldata.color = color
    lobj = bpy.data.objects.new(name, ldata)
    bpy.context.collection.objects.link(lobj)
    lobj.location = Vector(location)
    direction = Vector(look_at) - Vector(location)
    lobj.rotation_mode = "QUATERNION"
    lobj.rotation_quaternion = direction.normalized().to_track_quat("-Z", "Y")
    return lobj


def setup_studio_lights():
    # Crisp studio softbox key light from upper front-left
    add_area_light("KeyLight", (-2.6, -3.6, 2.7), (0, 0, 0.05), energy=360.0, size=2.4, color=(1.0, 0.94, 0.87))
    # Gentle cool-warm balanced fill from front-right
    add_area_light("FillLight", (2.8, -3.3, 0.9), (0, 0, 0.05), energy=155.0, size=3.4, color=(0.88, 0.92, 1.0))
    # Strong warm-amber silhouette rim lights so rich dark-brown fur pops brightly on pure #000000 Vanta Black!
    add_area_light("RimRight", (2.1, 2.6, 2.1), (0, 0, 0.1), energy=310.0, size=1.8, color=(1.0, 0.84, 0.64))
    add_area_light("RimLeft", (-2.2, 2.5, 1.8), (0, 0, 0.1), energy=260.0, size=2.0, color=(0.98, 0.84, 0.68))
    add_area_light("RimTop", (0.0, 2.4, 3.0), (0, 0, 0.4), energy=190.0, size=2.2, color=(1.0, 0.92, 0.84))
    # Soft bottom bounce
    add_area_light("Bounce", (0.0, -2.8, -2.5), (0, -0.3, -0.1), energy=95.0, size=3.0, color=(1.0, 0.92, 0.84))


def setup_camera(is_cub=False):
    cdata = bpy.data.cameras.new("StudioCam")
    cdata.lens = 68.0
    cdata.sensor_width = 36.0
    cam = bpy.data.objects.new("StudioCam", cdata)
    bpy.context.collection.objects.link(cam)
    dist = -5.45 if is_cub else -4.85
    z_off = 0.09 if is_cub else 0.10
    cam.location = Vector((0.0, dist, z_off))
    direction = Vector((0.0, 0.0, 0.08)) - cam.location
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = direction.normalized().to_track_quat("-Z", "Y")
    bpy.context.scene.camera = cam
    return cam


def build_base_bear(role, fur_rgb, snout_rgb, scale_mult=1.0, ear_scale=1.0):
    fur_mat = make_velvet_fur_mat(f"{role}_fur", fur_rgb, sheen_rgb=(0.98, 0.78, 0.56), roughness=0.83, bump_strength=0.045)
    snout_mat = make_velvet_fur_mat(f"{role}_snout", snout_rgb, sheen_rgb=(1.0, 0.95, 0.86), roughness=0.80, bump_strength=0.03)
    ear_pad_mat = make_velvet_fur_mat(f"{role}_ear_pad", snout_rgb, sheen_rgb=(1.0, 0.92, 0.82), roughness=0.84, bump_strength=0.03)
    nose_mat = make_satin_mat(f"{role}_nose", (0.025, 0.015, 0.010), roughness=0.18)
    mouth_mat = make_satin_mat(f"{role}_mouth", (0.035, 0.020, 0.012), roughness=0.30)

    s = scale_mult
    # Simple low-poly semi-3D beveled bear head (cohesive silhouette without pinched cheek seams!)
    head = add_lowpoly_plush_sphere(
        f"{role}_head",
        (0, 0, -0.02 * s),
        (1.06 * s, 0.88 * s, 0.93 * s),
        fur_mat,
        subdivisions=2,
        bevel_width=0.06,
    )

    # Classic bold round bear ears seated cleanly at upper-left/right so "BEAR" reads at 20px
    es = ear_scale * s
    for side, sx in [("L", -1.0), ("R", 1.0)]:
        ear = add_lowpoly_plush_sphere(
            f"{role}_ear_{side}",
            (sx * 0.73 * s, -0.02 * s, 0.69 * s),
            (0.35 * es, 0.21 * es, 0.35 * es),
            fur_mat,
            subdivisions=2,
            bevel_width=0.04,
        )
        ear.rotation_euler = Euler((math.radians(-6), sx * math.radians(-16), 0), "XYZ")
        pad = add_uv_sphere(
            f"{role}_earpad_{side}",
            (sx * 0.73 * s, -0.15 * s, 0.68 * s),
            (0.20 * es, 0.11 * es, 0.20 * es),
            ear_pad_mat,
            segs=24,
            rings=16,
        )
        pad.rotation_euler = ear.rotation_euler

    # Lighter cream-tan rounded snout positioned cleanly below the eyes/glasses
    add_uv_sphere(
        f"{role}_snout",
        (0, -0.68 * s, -0.24 * s),
        (0.45 * s, 0.33 * s, 0.30 * s),
        snout_mat,
        segs=34,
        rings=22,
    )

    # Cute dark espresso button nose at upper tip of snout (clean separation below glasses!)
    nose = add_uv_sphere(
        f"{role}_nose",
        (0, -0.98 * s, -0.12 * s),
        (0.155 * s, 0.11 * s, 0.105 * s),
        nose_mat,
        segs=24,
        rings=16,
    )
    nose.rotation_euler = Euler((math.radians(8), 0, 0), "XYZ")

    # Symmetrical cheerful smile arc (center of arc in local XY plane mapped straight to bottom in ZYX order)
    smile = add_torus(
        f"{role}_smile",
        location=(0, -0.985 * s, -0.215 * s),
        rotation_deg=(-82, 0, 212),
        major_r=0.145 * s,
        minor_r=0.017 * s,
        mat=mouth_mat,
        maj_seg=36,
        min_seg=10,
        arc_deg=116.0,
    )
    smile.rotation_euler = Euler((math.radians(-82), 0.0, math.radians(212)), "ZYX")
    _ = (head, smile)

    # Clean matte brown upper face above the snout for animated dot eyes
    eye_y = -0.82 * s
    eye_z = 0.20 * s
    eye_x = 0.335 * s
    return {
        "left_eye": Vector((-eye_x, eye_y, eye_z)),
        "right_eye": Vector((eye_x, eye_y, eye_z)),
        "head_scale": s,
    }


def add_round_glasses(role, left_eye, right_eye, mat, ring_radius=0.205, thickness=0.030, forward_offset=-0.105):
    gy = left_eye.y + forward_offset
    gz = left_eye.z
    lx = left_eye.x
    rx = right_eye.x
    add_torus(f"{role}_lens_L", (lx, gy, gz), (90, 0, 0), ring_radius, thickness, mat, maj_seg=48, min_seg=18)
    add_torus(f"{role}_lens_R", (rx, gy, gz), (90, 0, 0), ring_radius, thickness, mat, maj_seg=48, min_seg=18)
    bx0 = lx + ring_radius * 0.88
    bx1 = rx - ring_radius * 0.88
    add_cylinder(f"{role}_bridge", (bx0, gy, gz + 0.03), (bx1, gy, gz + 0.03), thickness * 0.85, thickness * 0.85, mat, segs=14)
    add_cylinder(f"{role}_arm_L", (lx - ring_radius, gy, gz + 0.02), (lx - ring_radius * 1.45, -0.15, gz + 0.08), thickness * 0.75, thickness * 0.65, mat, segs=12)
    add_cylinder(f"{role}_arm_R", (rx + ring_radius, gy, gz + 0.02), (rx + ring_radius * 1.45, -0.15, gz + 0.08), thickness * 0.75, thickness * 0.65, mat, segs=12)


def add_sunglasses(role, left_eye, right_eye, frame_mat, lens_mat):
    add_round_glasses(role, left_eye, right_eye, frame_mat, ring_radius=0.215, thickness=0.034, forward_offset=-0.11)
    gy = left_eye.y - 0.105
    gz = left_eye.z
    for side, ex in [("L", left_eye.x), ("R", right_eye.x)]:
        add_uv_sphere(f"{role}_darklens_{side}", (ex, gy, gz), (0.20, 0.032, 0.20), lens_mat, segs=28, rings=18)


def add_beret(role):
    beret_mat = make_velvet_fur_mat(f"{role}_beret", (0.018, 0.018, 0.022), sheen_rgb=(0.35, 0.35, 0.42), roughness=0.88, bump_strength=0.05, scale=110.0)
    disc = add_uv_sphere(f"{role}_beret_cap", (-0.18, -0.05, 0.91), (0.79, 0.68, 0.27), beret_mat, segs=40, rings=24)
    disc.rotation_euler = Euler((math.radians(-6), math.radians(-16), math.radians(8)), "XYZ")
    band = add_torus(f"{role}_beret_band", (-0.13, -0.06, 0.75), (84, 16, 0), 0.57, 0.085, beret_mat, maj_seg=44, min_seg=14)
    stem = add_cylinder(f"{role}_beret_stem", (-0.25, -0.06, 1.12), (-0.28, -0.05, 1.26), 0.048, 0.036, beret_mat, segs=14)
    _ = (disc, band, stem)


def add_headset(role):
    matte_black = make_satin_mat(f"{role}_hs_black", (0.032, 0.034, 0.040), roughness=0.30)
    trim_silver = make_metal_mat(f"{role}_hs_trim", (0.48, 0.50, 0.55), metallic=0.88, roughness=0.22)
    emerald_led = make_satin_mat(f"{role}_hs_led", (0.14, 0.92, 0.56), roughness=0.16, emission_rgb=(0.18, 0.96, 0.60), emission_strength=2.5)

    # Snug arch hugging crown closely without air gap
    band = add_torus(f"{role}_hs_band", (0.0, -0.02, 0.08), (90, 0, -2), 1.01, 0.072, matte_black, maj_seg=48, min_seg=14, arc_deg=184.0)
    cup = add_uv_sphere(f"{role}_hs_cup_l", (-1.04, -0.06, 0.05), (0.15, 0.27, 0.32), matte_black, segs=26, rings=18)
    ring = add_torus(f"{role}_hs_ring_l", (-1.10, -0.06, 0.05), (0, 90, 0), 0.21, 0.028, trim_silver, maj_seg=32, min_seg=12)
    boom1 = add_cylinder(f"{role}_hs_boom1", (-1.05, -0.14, -0.04), (-0.82, -0.58, -0.24), 0.026, 0.022, matte_black)
    boom2 = add_cylinder(f"{role}_hs_boom2", (-0.82, -0.58, -0.24), (-0.49, -0.84, -0.32), 0.022, 0.018, matte_black)
    tip = add_uv_sphere(f"{role}_hs_mic", (-0.47, -0.86, -0.325), (0.052, 0.052, 0.052), emerald_led, segs=18, rings=14)
    _ = (band, cup, ring, boom1, boom2, tip)


def add_monocle(role, right_eye):
    gold_mat = make_metal_mat(f"{role}_monocle_gold", (0.96, 0.74, 0.22), metallic=0.96, roughness=0.15)
    gx, gy, gz = right_eye.x, right_eye.y - 0.11, right_eye.z
    r = 0.22
    add_torus(f"{role}_monocle_ring", (gx, gy, gz), (90, 0, 0), r, 0.032, gold_mat, maj_seg=48, min_seg=18)
    add_uv_sphere(f"{role}_monocle_lug", (gx + r + 0.02, gy, gz - 0.03), (0.04, 0.04, 0.04), gold_mat, segs=16, rings=12)
    pts = [
        (gx + r + 0.02, gy, gz - 0.04),
        (gx + r + 0.11, gy + 0.08, gz - 0.24),
        (gx + r + 0.15, gy + 0.22, gz - 0.45),
        (gx + r + 0.11, gy + 0.36, gz - 0.62),
    ]
    for idx in range(len(pts) - 1):
        add_cylinder(f"{role}_chain_{idx}", pts[idx], pts[idx + 1], 0.015, 0.015, gold_mat, segs=10)


# Rich dark brown fur calibrated in linear RGB so AgX renders deep warm chocolate brown with bold tan snout contrast
ROLES = [
    {
        "id": "orchestrator",
        "fur": (0.165, 0.072, 0.024),
        "snout": (0.76, 0.56, 0.35),
        "accessory": "gold_glasses",
        "is_cub": False,
    },
    {
        "id": "team-lead",
        "fur": (0.125, 0.054, 0.022),
        "snout": (0.72, 0.52, 0.33),
        "accessory": "headset",
        "is_cub": False,
    },
    {
        "id": "builder",
        "fur": (0.105, 0.046, 0.020),
        "snout": (0.71, 0.51, 0.32),
        "accessory": "dark_glasses",
        "is_cub": False,
    },
    {
        "id": "artist",
        "fur": (0.185, 0.074, 0.026),
        "snout": (0.77, 0.57, 0.37),
        "accessory": "beret",
        "is_cub": False,
    },
    {
        "id": "research",
        "fur": (0.145, 0.060, 0.022),
        "snout": (0.74, 0.54, 0.34),
        "accessory": "shades",
        "is_cub": False,
    },
    {
        "id": "verifier",
        "fur": (0.095, 0.042, 0.018),
        "snout": (0.70, 0.50, 0.31),
        "accessory": "monocle",
        "is_cub": False,
    },
    {
        "id": "cub",
        "fur": (0.175, 0.082, 0.034),
        "snout": (0.78, 0.59, 0.39),
        "accessory": "none",
        "is_cub": True,
    },
]


def project_svg_coord(scene, cam, world_pt):
    co = world_to_camera_view(scene, cam, world_pt)
    svg_x = round(float(co.x) * 100.0, 2)
    svg_y = round((1.0 - float(co.y)) * 100.0, 2)
    return [svg_x, svg_y]


def main():
    anchors = {}
    if not bpy.app.background:
        raise RuntimeError("Run this scene-resetting script in a separate headless Blender process.")
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--fast", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    output_dir = args.output_dir.resolve()
    raw_out_dir = output_dir / "raw"
    raw_out_dir.mkdir(parents=True, exist_ok=True)
    anchors_out = output_dir / "eyeAnchors.json"
    samples = 28 if args.fast else 48

    for spec in ROLES:
        role_id = spec["id"]
        is_cub = spec["is_cub"]
        clear_scene()
        configure_render(samples=samples, res=512)
        setup_studio_lights()
        cam = setup_camera(is_cub=is_cub)

        bear_info = build_base_bear(
            role_id,
            fur_rgb=spec["fur"],
            snout_rgb=spec["snout"],
            scale_mult=1.0,
            ear_scale=1.14 if is_cub else 1.0,
        )
        le = bear_info["left_eye"]
        re = bear_info["right_eye"]

        acc = spec["accessory"]
        if acc == "gold_glasses":
            gold = make_metal_mat("orch_gold", (0.96, 0.72, 0.18), metallic=0.95, roughness=0.16)
            add_round_glasses(role_id, le, re, gold, ring_radius=0.205, thickness=0.028, forward_offset=-0.105)
        elif acc == "dark_glasses":
            charcoal = make_satin_mat("builder_frames", (0.028, 0.030, 0.038), roughness=0.28)
            add_round_glasses(role_id, le, re, charcoal, ring_radius=0.21, thickness=0.036, forward_offset=-0.11)
        elif acc == "shades":
            charcoal = make_satin_mat("scout_frames", (0.024, 0.025, 0.030), roughness=0.26)
            dark_lens = make_satin_mat("scout_lens", (0.015, 0.024, 0.030), roughness=0.10)
            add_sunglasses(role_id, le, re, charcoal, dark_lens)
        elif acc == "beret":
            add_beret(role_id)
        elif acc == "headset":
            add_headset(role_id)
        elif acc == "monocle":
            add_monocle(role_id, re)

        scene = bpy.context.scene
        bpy.context.view_layer.update()
        lx, ly = project_svg_coord(scene, cam, le)
        rx, ry = project_svg_coord(scene, cam, re)
        anchors[role_id] = {
            "left": [lx, ly],
            "right": [rx, ry],
            "hasShades": acc == "shades",
        }

        out_path = raw_out_dir / f"bear-{role_id}.png"
        scene.render.filepath = str(out_path)
        bpy.ops.render.render(write_still=True)
        print(f"Rendered {role_id} -> {out_path} eyes=({lx},{ly}) ({rx},{ry})", flush=True)

    with anchors_out.open("w", encoding="utf-8") as f:
        json.dump(anchors, f, indent=2)
    print(f"Wrote anchors to {anchors_out}", flush=True)


if __name__ == "__main__":
    main()
