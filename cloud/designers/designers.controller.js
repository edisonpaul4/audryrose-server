var { DesignersModel } = require('./designers.model');

exports.DesignersController = new class DesignersController {
  constructor(){}

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