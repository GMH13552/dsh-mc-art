package com.fleshland;

import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.Material;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

/**
 * 血肉之地。
 *
 * <p>这一版**故意不带任何资源**：贴图、模型、blockstate、lang 的唯一真相在
 * {@code fleshland/pack/}（那个资源包，也是面板和 mc-art skill 改的那一份）。
 * 在这里再手写一份就是第二个真相，迟早会和 atlas 对不上——以后由 datagen 从
 * atlas 生成到 {@code src/generated/resources/}。
 *
 * <p>所以现在这个模组只做一件事：把方块注册进游戏，好让 GameTest 能在**真的
 * Minecraft 服务端**里判它。裁判先立起来，资源随后接上。
 */
@Mod(FleshlandMod.MODID)
public class FleshlandMod {
    public static final String MODID = "fleshland";

    public static final DeferredRegister<Block> BLOCKS =
            DeferredRegister.create(ForgeRegistries.BLOCKS, MODID);
    public static final DeferredRegister<Item> ITEMS =
            DeferredRegister.create(ForgeRegistries.ITEMS, MODID);

    /** 血肉块：第一个被 GameTest 判分的方块。 */
    public static final RegistryObject<Block> FLESH_BLOCK = BLOCKS.register("flesh_block",
            () -> new Block(BlockBehaviour.Properties.of(Material.DIRT).strength(1.0F)));

    public static final RegistryObject<Item> FLESH_BLOCK_ITEM = ITEMS.register("flesh_block",
            () -> new BlockItem(FLESH_BLOCK.get(), new Item.Properties().tab(CreativeModeTab.TAB_BUILDING_BLOCKS)));

    public FleshlandMod() {
        IEventBus modBus = FMLJavaModLoadingContext.get().getModEventBus();
        BLOCKS.register(modBus);
        ITEMS.register(modBus);
    }
}
