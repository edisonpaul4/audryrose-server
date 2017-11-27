const { DesignersModel } = require('./designers.model');
const { ProductsModel } = require('../products/products.model');
const { OrdersModel } = require('../orders/orders.model');

exports.DesignersController = new class DesignersController {
  constructor(){}

  getAllPendingVendorOrders(page = 0, sort = "date_added" , direction = "ASC", ordersToSkip = []) {
    const variantsObjectsFromVendorOrder = vendorOrder => {
      const vendorOrderVariants = vendorOrder.get('vendorOrderVariants');
      const designer = vendorOrder.get('vendor').get('designers')[0];

      const getOrderProductByProductId = productId => OrdersModel.getOrderProductsByFilters({
        includes: ['product_options'],
        equal: [{ key: 'product_id', value: productId }]
      }).first();

      return Promise.all(vendorOrderVariants.map(vendorOrderVariant => {
        const productVariant = vendorOrderVariant.get('variant');
        return getOrderProductByProductId(productVariant.get('productId'))
          .then(productObject => ({
            vendorOrderObjectId: vendorOrder.id,
            vendorOrderVariantObjectId: vendorOrderVariant.id,
            designerObjectId: designer.id,
            designerId: designer.get('designerId'),
            productId: productVariant.get('productId'),
            dateAdded: vendorOrder.get('createdAt'),
            designerName: designer.get('name'),
            productName: productVariant.get('productName'),
            retailPrice: productVariant.get('adjustedPrice'),
            productOptions: productObject.get('product_options').map(productOption => ({
              displayName: productOption.display_name,
              displayValue: productOption.display_value,
            })),
            totalInventory: productVariant.get('inventoryLevel'),
            totalAwaiting: productVariant.get('totalAwaitingInventory'),
            unitsToOrder: vendorOrderVariant.get('units'),
            note: vendorOrderVariant.get('notes'),
            internalNote: vendorOrderVariant.get('internalNotes'),
            ordered: vendorOrderVariant.get('ordered'),
            deleted: vendorOrderVariant.get('deleted'),
            deletedAt: vendorOrderVariant.get('deletedAt'),
          }));
      }))
    };
    
    const filterAndGroupObjects = objects => objects.reduce((all, current) => [
      ...('push' in all ? all : []),
      ...current.filter(current => !current.ordered && !current.deleted)
    ], []);

    const filters = {
      limit: 1000,
      skip: page * 100,
      includes: ['vendor', 'vendor.designers', 'vendorOrderVariants', 'vendorOrderVariants.variant'],
      equal: [{ key: 'orderedAll', value: false }, { key: 'receivedAll', value: false }]
    }
    return DesignersModel.getVendorOrdersByFilters(filters)
      .find()
      .then(objects => Promise.all(objects.map(variantsObjectsFromVendorOrder)))
      .then(filterAndGroupObjects)
      .then(vendorOrders => ({
        success: true,
        count: vendorOrders.length,
        vendorOrders
      }));
  }

  /**
   * 
   * @param {String} vendorOrderObjectId
   * @param {String} vendorOrderVariantObjectId
   */
  finishPendingVendorOrderProduct(vendorOrderObjectId, vendorOrderVariantObjectId) {
    return DesignersModel.finishPendingVendorOrderProduct(vendorOrderObjectId, vendorOrderVariantObjectId)
      .then(result => ({
        success: true,
        ...result
      }));
  } // END finishPendingVendorOrderProduct

  /**
   * @returns {Promise} <{ success: boolean }>
   */
  fixClearedVendorOrdersResults() {
    console.log('DesignersController::fixClearedVendorOrdersResults');
    const clearedOrders = DesignersModel.getForcedClearedOrders()
      .then(vendorOrders => vendorOrders.filter(vendorOrder => !vendorOrder.has('dateReceived')));

    const updateVendorOrder = vendorOrders => vendorOrders.map(vendorOrder => {
      const updatedAtAsDateReceived = vendorOrder.get('updatedAt');
      return vendorOrder.set('dateReceived', updatedAtAsDateReceived).save()
        .then(vendorOrder => Promise.all(updateVendorOrderVariants(vendorOrder.get('vendorOrderVariants'))));
    });

    const updateVendorOrderVariants = vendorOrderVariants => vendorOrderVariants.map(vov => vov.set('done', true).save());

    return Promise.resolve(clearedOrders)
      .then(vendorOrders => Promise.all(updateVendorOrder(vendorOrders)))
      .then(() => ({ success: true }));
  }

  completeVendorOrder(vendorOrderNumber) {
    console.log('DesignersController::completeVendorOrder => starting for vendor order number:', vendorOrderNumber);

    var getUpdatedDesignersFromVendorOrder = vendorOrder => {
      console.log('DesignersController::completeVendorOrder::getUpdatedDesignersFromVendorOrder');
      var designer = vendorOrder.get('vendor').get('designers')[0];
      return DesignersModel.getDesignerByObjectId(designer.id)
        .then(updatedDesigner => ({
          updatedDesigner: updatedDesigner.toJSON(),
          vendorOrder: vendorOrder.toJSON()
        }));
    }

    return DesignersModel.finishVendorOrder(vendorOrderNumber)
      .then(getUpdatedDesignersFromVendorOrder);
  }

  removeVendorOrderProduct(productObjectId, vendorOrderNumber){
    console.log('DesignersController::removeVendorOrderProduct => starting for vendor order number:', vendorOrderNumber);
    return DesignersModel.deleteProductFromVendorOrder(productObjectId, vendorOrderNumber)
      .then(results => ({
        vendorOrder: results.vendorOrder.toJSON(),
        vendorOrderVariant: results.vendorOrderVariant.toJSON(),
      }))
  }

}