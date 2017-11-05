var { DesignersModel } = require('./designers.model');

exports.DesignersController = new class DesignersController {
  constructor(){}

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